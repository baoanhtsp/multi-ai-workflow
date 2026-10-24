# S6 — Agent workspace: design (stream lead: Claude)

Items: V1, V2, V3, V4 + N10, V5 + B4 + B1, B3, B6, N7, V8, N11 (see `specs/streams/s6-workspace.md`, SPEC §9.4–9.6).
Re-implemented from the behaviour seen in the videos. **No Maestro code is used** (AGPL).

Ownership (SPEC §9.5):
- Antigravity (backend): `server/features/{agents-ws,teams,chat,handoffs,memory}/**` (including their `tests/`), `scripts/hooks/*/60-*.ps1`.
- Claude (frontend + this design): `dashboard/feat-{workspace,teams,palette}.{js,css}`, `specs/s6-*.md`.

---

## 0. Principles and constraints

- **Same runner.** Every chat turn, handoff and compaction is a normal job started with `ctx.startJob(body)`. Logs, SSE (`job_stream`), `cancel_job`, notifications, audit, the `job-start` / `job-finish` / `before-agent` hooks (S1 checkpoints, S3 health, S4 budget / policy) all keep working.
  - The runner currently accepts `mode: "task"` only for our purposes, with role ∈ `architect|backend|frontend|reviewer|tester`.
  - S6 therefore starts turns as `mode: "task"` and keeps its own `job_id → conversation / turn` map. The `mode: "chat"` marker and true CLI resume are **Requests to Tech Lead** (§9).
- **Resume strategy today = replay.** Each turn's prompt is: brief + memory + conversation summary + the most recent messages + the new message, capped to fit the 20 000-character prompt limit (budget **17 000** chars for the whole prompt).
  - The platform's resume token is still captured from the log (Claude session id when printed, Codex `Thread: <id>`, Antigravity `CONVERSATION_ID: <id>`) and stored on the conversation, so real resume can switch on as soon as the runner supports it (`status.features` contains `chat-resume`).
- **Zero dependencies**, `node:*` only. Every child process uses an argument array (`shell: false`, `windowsHide: true`).
- **Data**:
  - global: `paths.featureDataDir('<feature>')` = `$MAW_HOME/data/<feature>/` (each feature only touches its own folder);
  - per project (versioned with the repo): `<project>/.maw/team.json`, `<project>/.maw/roles/*.md`, `<project>/.maw/memory/decisions.md`, `<project>/.maw/attachments/`.
- **Validation**: every `project_path` / `workdir` goes through `resolveProjectPath(path, paths.projectsRoot)`; ids match strict regexes; every string field has a max length; errors are `ApiValidationError` (400 / 404 / 409).
- **Writes are atomic**: write `<file>.tmp` then rename. One in-process async mutex per data file (no lost updates when two requests race).
- **Destructive actions** (delete agent / group / conversation / memory entry / template, cancel handoff, stop) are confirmed in the UI and append one line to `$MAW_HOME/data/<feature>/audit.jsonl`: `{ ts, action, target, detail }`.
- **Background tick**: the `chat` feature runs one `setInterval(tick, 2000).unref()` (started lazily on the first S6 request, so `node --test` never hangs), plus a `tick()` call at the start of `ws_state`, `chat_get`, `chat_list` and `handoff_list`. `tick()` is idempotent and re-entrancy-safe (one in flight at a time). It:
  1. finalises finished turn jobs (reads the job meta through `refreshJobMetaStatus`, parses the log);
  2. starts the next queued message of an idle conversation;
  3. finalises finished handoff jobs and starts waiting handoffs within `max_parallel`;
  4. runs the compaction check.
  After a server restart, the tick reconciles from the stored `active_job_id`s (nothing is lost).

## 1. Feature modules

| Feature dir | Actions | `ui` |
| :--- | :--- | :--- |
| `agents-ws` | `ws_state`, `ws_platforms`, `ws_agent_save`, `ws_agent_delete`, `ws_agent_restore`, `ws_agent_duplicate`, `ws_agent_move`, `ws_group_save`, `ws_group_delete` | `feat-workspace.js` + `.css` |
| `chat` | `chat_list`, `chat_get`, `chat_create`, `chat_rename`, `chat_delete`, `chat_send`, `chat_queue_remove`, `chat_stop`, `chat_compact` | — |
| `handoffs` | `handoff_list`, `handoff_dispatch`, `handoff_cancel`, `handoff_retry`, `handoff_accept` | — |
| `teams` | `team_get`, `team_save`, `team_apply`, `team_export`, `team_import`, `team_templates`, `team_template_save`, `team_template_delete`, `team_profiles`, `team_profile_save`, `team_profile_delete` | `feat-teams.js` + `.css` |
| `memory` | `memory_list`, `memory_add`, `memory_update`, `memory_delete`, `memory_context` | `feat-palette.js` + `.css` (the global palette is not tied to one feature; it rides on `memory` because each feature has one script) |

Shared server code lives in `server/features/agents-ws/lib/*.ts` (store helpers, mutex, log parser, prompt builder) and is imported by the other S6 features with relative `.ts` imports.

Every response is `{ ok: true, ... }` / `{ ok: false, error }` like the rest of the API.

---

## 2. V2 — Persistent agents (`agents-ws`)

Files: `agents-ws/agents.json` `{ version: 1, agents: Agent[] }`, `agents-ws/groups.json` `{ version: 1, groups: Group[] }`.

```jsonc
// Agent
{
  "id": "ag_1a2b3c4d",                 // ^ag_[a-f0-9]{8}$ (server generated)
  "name": "Worker A",                  // 1–60 chars, unique among live agents (case-insensitive)
  "group_id": "",                      // "" = ungrouped, else ^gr_[a-f0-9]{8}$
  "order": 0,                          // position inside the group
  "platform": "claude",                // enabled registry id
  "model": "",                         // "" or one of the platform's models
  "effort": "",                        // "" or one of the platform's efforts
  "workdir": "C:\\laragon\\www\\proj", // resolveProjectPath; required
  "role": "backend",                   // exec role for the runner: architect|backend|frontend|reviewer|tester (default backend)
  "persona": "",                       // ≤ 4000 chars, prepended to every brief
  "team_id": "", "team_role": "",      // set by team_apply (lead|deputy|planner|worker|testing|hacker|<custom key>)
  "cli_args": [],                      // ≤ 20 strings × ≤ 200 chars, no NUL / CR / LF (stored; applied when the runner supports it, §9)
  "env": {},                           // ≤ 30 keys ^[A-Z_][A-Z0-9_]{0,63}$, values ≤ 1000 chars; PATH, SYSTEMROOT, COMSPEC, MAW_* refused
  "hooks": { "before": "", "after": "" }, // text added before / after every message (≤ 2000 chars each)
  "retry_policy": { "max_attempts": 0, "backoff_sec": 30 },  // 0–5 attempts, 5–1800 s; a FAILED turn is re-run automatically
  "bookmark": false,
  "created_at": "ISO", "updated_at": "ISO",
  "deleted_at": null                   // soft delete
}
// Group
{ "id": "gr_1a2b3c4d", "name": "Backend team", "order": 0, "collapsed": false, "team_id": "" }
```

Live status (computed, never stored) added to each agent in `ws_state`:
`status` = `thinking` (a turn job is RUNNING) | `waiting` (a handoff for it is `started`, or its queue is non-empty while idle) | `error` (last turn FAILED) | `needs-login` (last failed log matches an auth pattern: `OAuth session expired`, `Please set an Auth method`, `not logged in`, `401 Unauthorized`, `login required`) | `idle`; plus `active_job_id`, `active_conversation_id`, `queue_len`, `last_activity`, `git: { branch, ahead, behind, modified }` (from `getProjectGitInfo(workdir)`, cached 30 s per workdir).

### Actions
- `GET ws_state?project_path=<opt>` → `{ ok, agents: Agent+live[], groups: Group[], deleted: Agent[] (soft-deleted in the last 24 h, newest first, max 20), platforms: Platform[], features: { isolate: bool, resume: bool } }`.
  - `project_path` given ⇒ agents whose `workdir` equals it come first (no filtering, the UI filters).
  - `Platform` = `{ id, label, color, installed, version, models, efforts, capabilities }` from `ctx.registry` + `detectRegistryAgents` (its cache).
- `GET ws_platforms?refresh=1` → `{ ok, platforms }`. `refresh=1` re-runs detection (bypasses the cache when `detectRegistryAgents` allows it; otherwise returns the cached data with `cached: true`).
- `POST ws_agent_save { agent }` → `{ ok, agent }`. No `id` ⇒ create; with `id` ⇒ partial update of the given fields. 404 unknown id.
- `POST ws_agent_delete { id }` → `{ ok, id, deleted_at }` (soft). 409 while a turn is running.
- `POST ws_agent_restore { id }` → `{ ok, agent }`.
- `POST ws_agent_duplicate { id }` → `{ ok, agent }` (name `"<name> (copy)"`, same group, new id, no conversations).
- `POST ws_agent_move { id, group_id, order? }` → `{ ok, agent }` (re-numbers `order` inside the target group).
- `POST ws_group_save { group }` → `{ ok, group }` (create / rename / collapse / reorder).
- `POST ws_group_delete { id }` → `{ ok, moved: n }`: its agents move to `group_id: ""` (never deleted).

---

## 3. V3 + B6 + B3 — Multi-turn chat (`chat`)

Files: `chat/conversations.json` `{ version: 1, conversations: Conversation[] }` and `chat/conv/<conversation_id>.jsonl` (one `Message` per line, append-only; edits rewrite the file atomically).

```jsonc
// Conversation
{
  "id": "cv_1a2b3c4d5e",          // ^cv_[a-f0-9]{10}$
  "agent_id": "ag_…",
  "title": "Chat 1",              // ≤ 80 chars; auto-set from the first user message (first 48 chars)
  "kind": "chat",                 // chat | handoff (a member conversation created for a handoff)
  "created_at", "updated_at",
  "deleted_at": null,
  "seq": 12,                      // last message seq
  "session": 1,                   // ++ on compaction or platform switch
  "platform": "claude", "model": "", "effort": "",   // of the last turn
  "resume": { "platform": "claude", "token": "…", "session": 1 } | null,
  "summary": "", "summary_seq": 0,                  // compaction summary covers messages ≤ summary_seq
  "active_job_id": "", "active_kind": "",           // "turn" | "compact"
  "active_started_at": "",
  "queue": [ { "id": "q_1a2b3c", "text": "…", "platform"?, "model"?, "effort"?, "ts" } ],   // ≤ 20 items
  "cost_usd": 0, "tokens_in": 0, "tokens_out": 0,
  "context": { "used_tokens": 0, "window_tokens": 200000, "pct": 0 },
  "last_status": "", "last_error": ""
}
// Message
{
  "seq": 3, "id": "m_1a2b3c4d",
  "role": "user" | "assistant" | "system" | "handoff",
  "text": "…",                    // user ≤ 20000 chars; assistant stored ≤ 60000 chars
  "ts": "ISO",
  "platform", "model", "effort",  // what was requested
  "actual_model": "",             // B3: what the CLI reported
  "job_id": "", "status": "queued" | "running" | "done" | "failed" | "cancelled",
  "cost_usd": null, "tokens_in": null, "tokens_out": null, "duration_sec": null,
  "attachments": [ { "name": "x.png", "path": ".maw/attachments/cv_…/x.png" } ],
  "handoff_id": "",               // role "handoff" (a member result returned to the Lead) or a Lead message that dispatched
  "steered": false                // true = injected into the running Antigravity session
}
```

### Turn lifecycle
1. `chat_send` while idle ⇒ append the user message (`status: running`), build the prompt (§3.1), call
   `ctx.startJob({ mode: 'task', agent: platform, role: agent.role, model, effort, new_session, project_path: agent.workdir, prompt, isolate: false })`.
   - `new_session` is `true` for platforms with `capabilities.new_session` (Antigravity) so a turn never lands in an unrelated "latest" conversation.
   - Store `active_job_id`; return `{ ok, message, job_id, queued: false }`.
2. `chat_send` while busy:
   - If the running turn's platform is `antigravity` and its conversation id is known (from `resume.token` or `CONVERSATION_ID:` in the running log) ⇒ **steer**: spawn `invoke-antigravity.ps1 -Action send -ConversationId <id> -NoWait -PromptFile <tmp>` (argument array). The message is stored with `steered: true`. Response `{ ok, message, steered: true }`.
   - Otherwise append to `queue` (409 when 20 are waiting). Response `{ ok, queued: true, queue_item, queue_len }`. The UI shows "n mục đang chờ".
3. `tick()` sees the job finished ⇒ parse the log (§3.2) ⇒ append the assistant message (`done` / `failed` / `cancelled`), update cost / tokens / context / resume token, clear `active_job_id`.
   - `FAILED` and `retry_policy.max_attempts > attempts` ⇒ re-run after `backoff_sec` (`system` message "Thử lại lần n").
   - Then the handoff parser runs on Lead replies (§5), then the next queue item starts.
4. Platform switch: a `chat_send` whose `platform` differs from `conversation.platform` ⇒ `session++`, a `system` message "Đổi nền tảng claude → codex (phiên mới, kèm tóm tắt)", and the new session's prompt is seeded with the summary (the compaction summary, or a quick summary = the last 8 messages trimmed to 300 chars each).
5. Images: `attachments: [{ name, data_url }]` (PNG / JPEG / WebP / GIF, ≤ 150 KB each, ≤ 3) are accepted only for platforms in `IMAGE_PLATFORMS = ['claude', 'codex', 'gemini', 'cursor']` (they read files by path); 400 otherwise. Saved to `<workdir>/.maw/attachments/<conversation>/<n>-<safe name>`, and the prompt gets `Attached image: <relative path>`.

### 3.1 Prompt builder (shared, `agents-ws/lib/prompt.ts`)
In this order, total ≤ 17 000 chars (trim the history first, then memory, never the new message):
1. `# Agent` — name, team role, persona, and for team members the role profile sections (§4).
2. `# Project memory` — `memory_context` excerpt (pinned + keyword match on the new message, ≤ 2500 chars) (§6).
3. `# Conversation summary (session n)` — `summary` when present.
4. `# Recent messages` — newest-first selection of messages after `summary_seq`, rendered oldest-first as `User:` / `<Agent name>:` / `[Handoff …]`, each ≤ 2500 chars.
5. `# Message` — `hooks.before` + the new text + `hooks.after` (+ attachment lines).
6. For a Lead (team role with `may_delegate`): the **dispatch tool** instructions (§5.1).

### 3.2 Log parser (shared, `agents-ws/lib/logparse.ts`, unit-tested)
Input: the job log text. Output `{ reply, actual_model, cost_usd, tokens_in, tokens_out, resume_token, auth_error }`.
- Skip the runner header (everything up to the first `-----` line) and the `=== [JOB_FINISHED …] ===` / `=== [MISSION CONTROL JOB …] ===` lines.
- `actual_model`: `[Connected] Model: <m>` (Claude) / `[Connected] OpenAI Codex Thread: <id> | Model: <m>` (Codex) / `Model: <m>` in a `[Connected]` line of any adapter.
- `resume_token`: Codex thread id, `CONVERSATION_ID: <uuid>` (Antigravity), `"session_id":"<id>"` in a Claude stream-json line.
- cost / tokens: `[Completed … | Tokens: <in> in / <out> out | … Cost: $<x>]`.
- `reply`: the remaining lines minus lines that start with `[Connected]`, `[Action]`, `[Done]`, `[Completed`, `[HOOK`, `HOOK_BLOCKED`, `[HH:mm:ss] Invoking`, and raw JSON event lines (`{"type":…}`). Trimmed, ≤ 60 000 chars. Empty reply on a FAILED job ⇒ the last 30 log lines as the error text.
- `auth_error`: the auth patterns from §2.

### 3.3 B6 — Context meter and compaction
- `window_tokens` per platform: claude 200 000, codex 272 000, gemini 1 000 000, antigravity 1 000 000, cursor 200 000, aider 128 000, otherwise 128 000 (a constant table; the registry may later carry `context_window`).
- `used_tokens` = estimated tokens (chars / 3.8) of `summary` + every message after `summary_seq`, or the parsed `tokens_in` of the last turn when it is larger.
- **Compaction trigger** (checked by `tick()` when the conversation is idle): `pct ≥ threshold` (default **0.70**, setting `chat/settings.json { compact_threshold }`), **or** the messages after `summary_seq` no longer fit the replay budget (older ones would be dropped).
- Compaction = a job with the same agent / platform and the prompt "Summarize this conversation for your own continuation: goals, decisions, current state, open items, file paths. ≤ 1200 words." + the previous summary + all messages after `summary_seq` (capped). On DONE: `summary = reply`, `summary_seq = seq at start`, `session++`, `resume = null`, system message "Đã nén ngữ cảnh (phiên n)". `active_kind: "compact"`; user messages arriving meanwhile are queued.
- `POST chat_compact { conversation_id }` forces it (409 while busy).
- Members only report summaries to the Lead (§5): the Lead never receives a member's full log.

### Actions
- `GET chat_list?agent_id=` → `{ ok, conversations: Conversation[] }` (not deleted, newest first; without `agent_id`: all, max 200 — used by the palette).
- `GET chat_get?conversation_id=&after_seq=0` → `{ ok, conversation, messages: Message[] (after after_seq, max 300 newest), running: { job_id, kind, elapsed_sec, log_tail } | null }` (`log_tail` = last 1500 chars of the running job log, for the "đang suy nghĩ…" preview).
- `POST chat_create { agent_id, title? }` → `{ ok, conversation }`.
- `POST chat_rename { conversation_id, title }` → `{ ok, conversation }`.
- `POST chat_delete { conversation_id }` → `{ ok }` (soft; 409 while busy).
- `POST chat_send { conversation_id, text, platform?, model?, effort?, attachments? }` → see lifecycle. Text 1–20 000 chars. Model / effort validated against the platform.
- `POST chat_queue_remove { conversation_id, queue_id }` → `{ ok, queue }`.
- `POST chat_stop { conversation_id }` → cancels the active job through `handleCancelJob({ job_id }, paths)`; the running message becomes `cancelled`; the queue is kept. `{ ok, cancelled: job_id }`.
- `POST chat_compact { conversation_id }` → `{ ok, job_id }`.

---

## 4. V4 + N10 — Team builder (`teams`)

### 4.1 Files in the project (versioned)
`<project>/.maw/team.json`:
```jsonc
{
  "version": 1,
  "id": "tm_1a2b3c4d",
  "name": "Full Team",
  "template": "full",                  // template id it was created from
  "shared": {
    "workdir": "",                     // "" = the project itself; else resolveProjectPath
    "platform": "claude", "model": "", "effort": "",
    "write_scope": ["**"],             // globs relative to the workdir (≤ 30, each ≤ 200 chars)
    "writable_dirs": [],               // extra dirs (≤ 10, each resolveProjectPath)
    "isolate": true,                   // members run in their own worktree (S1); ignored when S1 is missing
    "max_parallel": 3,                 // concurrent handoffs (1–6)
    "auto_continue": true              // when all handoffs of a Lead turn are done, the Lead continues automatically
  },
  "roles": [{
    "key": "lead",                     // ^[a-z][a-z0-9-]{1,23}$, unique
    "name": "Lead",                    // ≤ 40 chars
    "enabled": true,
    "working_style": "persistent",     // persistent | per_task | new_chat_per_task
    "persona": "",                     // ≤ 4000 chars
    "may_delegate": true,
    "exec_role": "architect",          // runner role: architect|backend|frontend|reviewer|tester
    "override": { "workdir"?: "", "platform"?: "", "model"?: "", "effort"?: "", "write_scope"?: [] },
    "agent_id": ""                     // filled by team_apply
  }]
}
```
`<project>/.maw/roles/<key>.md` (one per role, plain Markdown so it diffs well):
```md
# Lead
## Responsibility
…
## Delegation & reporting
…
## Output
…
## Permissions
…
```
The four sections are parsed by their `##` headings (case-insensitive, Vietnamese aliases `Trách nhiệm`, `Giao việc & báo cáo`, `Đầu ra`, `Quyền`). Unknown sections are kept verbatim (round-trip safe). Each section ≤ 6000 chars.

### 4.2 Built-in templates
- `full` — six roles:

| key | name | exec_role | style | may_delegate | default write_scope |
| :--- | :--- | :--- | :--- | :--- | :--- |
| lead | Lead | architect | persistent | yes | `SPEC.md`, `specs/**`, `.maw/**` |
| deputy | Deputy | reviewer | persistent | yes | (read-only) `[]` |
| planner | Planner | architect | per_task | no | `specs/**`, `docs/**` |
| worker | Worker | backend | per_task | no | `**` |
| testing | Testing | tester | new_chat_per_task | no | `tests/**`, `**/*.test.*` |
| hacker | Hacker | reviewer | new_chat_per_task | no | (read-only) `[]` |

  Each role ships short default texts for the four sections (EN, ≤ 600 chars each), e.g. Hacker: "Responsibility: attack the change — injection, path traversal, auth bypass, secrets, unsafe shell. Output: findings with file:line, severity, a proof or reproduction. Permissions: read-only; never push, never run destructive commands."
- `empty` — only `lead`.

### 4.3 Library (global, `teams/`)
- `teams/templates.json` — user templates `{ id: "tt_…", name, team (without ids / agent_id), roles_md: { <key>: sections }, updated_at }`.
- `teams/profiles.json` — role profile library `{ id: "rp_…", name, role: <Role without key-specific ids>, sections, updated_at }`.

### 4.4 Actions
- `GET team_get?project_path=` → `{ ok, team: Team | null, roles_md: { <key>: { responsibility, delegation, output, permissions, extra } }, path: "<project>/.maw/team.json" }`.
- `POST team_save { project_path, team, roles_md }` → validates, writes `team.json` + every `roles/<key>.md` (removes the md of roles that were removed), `{ ok, team }`.
- `POST team_apply { project_path }` → creates / updates one persistent agent per **enabled** role (name = role name, platform / model / effort / workdir from override ⇒ shared, `role` = `exec_role`, `persona`, `team_id`, `team_role`), in a group named after the team (created if missing, `team_id` set). Writes the `agent_id`s back into `team.json`. Agents of roles that were disabled / removed are left alone (not deleted). `{ ok, team, agents, group }`.
- `GET team_export?project_path=` → `{ ok, bundle: { kind: "maw-team", version: 1, team, roles_md } }`.
- `POST team_import { project_path, bundle, overwrite? }` → validates the bundle (`kind`, `version`), 409 when a team exists and `overwrite` is not true, then same as `team_save` (ids regenerated, `agent_id`s cleared).
- `GET team_templates` → `{ ok, templates: [ { id: "full", name, builtin: true, team, roles_md }, { id: "empty", … }, …user ] }`.
- `POST team_template_save { id?, name, team, roles_md }` → `{ ok, template }` (create or update a user template; built-ins are read-only ⇒ 400).
- `POST team_template_delete { id }` → `{ ok }`.
- `GET team_profiles` / `POST team_profile_save { id?, name, role, sections }` / `POST team_profile_delete { id }`.
- "Suggest from scoreboard" is UI-only: it calls S4 `suggest_team { project_path }` when `status.features` contains `scoreboard`, and maps `{ <role>: agent }` onto `override.platform`.

---

## 5. V5 + B4 + B1 — Handoffs (`handoffs`)

### 5.1 Dispatch tool (in the Lead's brief)
The Lead dispatches by ending its reply with one fenced block:
````
```handoff
{ "handoffs": [ { "to": "worker", "task": "Implement …", "acceptance": "tests pass", "thread": "" } ] }
```
````
- `to` = a role key of the team (or a member agent id / name). `task` 1–8000 chars. ≤ 6 handoffs per Lead turn. `thread` = the id of an earlier handoff to continue the same member conversation (only for `per_task`).
- The brief explains the members (role key, name, platform, responsibility one-liner) and says: "Do not do members' work yourself. Results come back as `[Handoff <id>]` messages."
- The message keeps the block; the UI renders it as dispatch cards.
- The UI can also dispatch manually (`handoff_dispatch`).

### 5.2 Record (`handoffs/handoffs.json` `{ version: 1, handoffs: Handoff[] }`, newest 500 kept)
```jsonc
{
  "id": "h_1a2b3c4d",
  "team_id": "tm_…", "lead_agent_id": "ag_…", "lead_conversation_id": "cv_…", "lead_seq": 7,
  "batch": "b_1a2b3c",                 // all handoffs of one Lead turn
  "from": "ag_lead", "to": "ag_member", "to_role": "worker",
  "task": "…", "acceptance": "",
  "status": "started",                 // started (waiting for a slot) | running | completed | failed | blocked | needs_review | cancelled
  "job_id": "", "member_conversation_id": "cv_…",
  "isolated": false, "worktree": "", "branch": "",
  "platform": "codex", "actual_model": "",
  "created_at", "started_at", "finished_at", "duration_sec": null,
  "result": null,                      // B4 structured result, see 5.3
  "parse_error": "",                   // when status = needs_review
  "scope_violations": [],              // B1: files outside the role's write_scope
  "attempts": 0
}
```

### 5.3 Structured result (B4)
The member brief ends with: "Finish with exactly one fenced ```json block:" and this schema:
```jsonc
{ "status": "completed" | "failed" | "blocked",
  "summary": "≤ 1500 chars",
  "files_changed": ["relative/path", …],      // ≤ 200
  "evidence": "test output / commands run (≤ 3000 chars)",
  "blockers": ["…"],                          // ≤ 20
  "cost": 0.0 | null,
  "decisions": ["ADR-worthy decision", …] }   // optional, ≤ 10 → project memory (§6)
```
- Parser: the **last** fenced `json` block of the reply; `JSON.parse`; strict validation (types, lengths; unknown keys dropped). Failure ⇒ handoff `needs_review` with `parse_error`, `result` = `{ status: "failed", summary: <first 1500 chars of the reply>, … }`.
- Job FAILED with no block ⇒ `failed`. Job CANCELLED ⇒ `cancelled`.
- `cost`: the parsed job cost wins over the self-reported one.

### 5.4 Isolation and write scope (B1)
- Member job body: `{ mode: 'task', agent, role: exec_role, model, effort, project_path: workdir, prompt, isolate: team.shared.isolate }`. When the started job's meta (re-read from `jobsDir/<job>.json`) carries `worktree` / `branch` (S1), they are stored and `isolated = true`; otherwise `isolated = false` and the UI shows "chạy chung thư mục (S1 chưa có)".
- Write-scope check after the job: changed files = `result.files_changed` ∪ `git diff --name-only <base>…HEAD` + `git status --porcelain` in the worktree (argument arrays; only when isolated, because the shared folder mixes members). Every file that matches none of the role's `write_scope` globs (role override ⇒ shared) ⇒ `scope_violations`. Read-only roles (`[]`) violate on any change. Violations ⇒ status `needs_review`.
- SPEC Guard: when isolated, also run `handleSpecGuard({ project_path: worktree, owner: platform }, paths)` best-effort; a `FAIL` verdict adds its violations to `scope_violations`.
- Merge after review is S1 (`worktree_merge`); the UI offers it on completed isolated handoffs when `worktree_merge` exists.

### 5.5 Return to the Lead
- On a terminal status: append a `handoff` message to the Lead's conversation: `[Handoff h_1a2b] worker · Worker A (codex) completed in 2m10s — <summary ≤ 600 chars> · files: 4 · blockers: 0`. Nothing else from the member's log.
- When every handoff of the batch is terminal and `auto_continue` is true: queue a Lead message (`role: user`, marked `system_generated: true`) containing a compact table (id, role, status, summary ≤ 300 chars, files count, blockers) and "Continue the plan, dispatch fixes, or write the final summary."
- `result.decisions[]` of completed handoffs ⇒ `memory_add` entries (source `handoff:<id>`).
- `status` feature data: `feature_data.handoffs = { pending: n, running: n, recent: [ { id, to_role, status, summary, finished_at } ×10 ] }` so S3 inbox can show finished handoffs without calling S6. The UI also emits the `handoff-done` event (MAW event, see §8) for S3.

### 5.6 Actions
- `GET handoff_list?conversation_id=&team_id=&status=&limit=100` → `{ ok, handoffs, counts: { started, running, completed, failed, blocked, needs_review, cancelled } }` (`conversation_id` matches the Lead or member conversation).
- `POST handoff_dispatch { lead_conversation_id, to, task, acceptance? }` → `{ ok, handoff }` (manual dispatch; 400 if the conversation's agent has no team).
- `POST handoff_cancel { id }` → cancels the job if running, status `cancelled`.
- `POST handoff_retry { id }` → new attempt (same record, `attempts++`, status `started`).
- `POST handoff_accept { id, note? }` → `needs_review` ⇒ `completed` (user override, audited).

---

## 6. N7 — Project memory (`memory`)

`<project>/.maw/memory/decisions.md`:
```md
# Project decisions

## ADR-0003 · Use SSE for live logs
<!-- maw-memory {"id":"ADR-0003","date":"2026-10-25","source":"handoff:h_1a2b3c4d","agent":"codex","pinned":true,"tags":["api","ui"]} -->
Body (Markdown, ≤ 4000 chars).
```
- Parsed by `## ADR-` headings + the metadata comment. Text before the first entry is preserved. Hand edits in an editor stay valid (a missing comment ⇒ defaults, id from the heading).
- Actions:
  - `GET memory_list?project_path=&q=` → `{ ok, entries: [ { id, title, body, date, source, agent, pinned, tags } ], path }` (newest first; `q` filters title / body / tags, case-insensitive).
  - `POST memory_add { project_path, title, body, tags?, pinned?, source?, agent? }` → `{ ok, entry }` (next number; title ≤ 120, tags ≤ 10 × ≤ 24 `^[\p{L}\p{N}_-]+$`).
  - `POST memory_update { project_path, id, title?, body?, tags?, pinned? }` → `{ ok, entry }`.
  - `POST memory_delete { project_path, id }` → `{ ok }` (audited).
  - `GET memory_context?project_path=&q=&max_chars=2500` → `{ ok, text, ids }`: pinned entries first, then entries ranked by keyword overlap with `q` (words ≥ 3 chars, case-insensitive), concatenated as `- ADR-0003 Title: first 400 chars of body`, capped.
- Exported function `getMemoryContext(projectPath, q, maxChars)` for the prompt builder.

---

## 7. B3 — Readiness

- UI button "Kiểm tra sẵn sàng" (team builder + workspace top bar): calls S3 `health_check { agents: [...] }` when `status.features` contains `health`; otherwise builds the table from `ws_platforms` (installed / version) and marks login as "chưa rõ (S3 chưa có)". No LLM call, ~1 s.
- Table: role, agent, platform, configured model, **actual model** (from the member's last turn `actual_model`), status, reason.

---

## 8. Frontend (Claude)

### 8.1 Files
- `dashboard/feat-workspace.js|css` — the view, chat, handoff panel, context menu, agent editor. Defines `MAW.ws` (§8.4).
- `dashboard/feat-teams.js|css` — team builder modal, template / profile library, readiness table.
- `dashboard/feat-palette.js|css` — global Ctrl+K palette.
Scripts can load in any order, so `feat-teams.js` / `feat-palette.js` wait for `MAW.ws` through `window.MAW_WS_READY` (an array of callbacks drained by the workspace).

### 8.2 V1 layout (`MAW.addView({ id: 'workspace', title: 'Không gian agent' / 'Workspace' })`)
```
┌ top bar: [agent ▾] · ⎇ branch · +12 −3 · $0.42 · ctx ▮▮▮▯▯ 41% · [Sẵn sàng?] [Đội ▾] ───────────┐
├ left 260px ──────────┬ centre (flex) ─────────────────────────────┬ right 340px ────────────────┤
│ 🔍 filter            │ [Chat 1] [Fix login ×] [+]                 │ [Files] [History] [Auto Run] │
│ ▾ Backend team  (3)  │                                            │ [Handoffs (2)]               │
│   ● Worker A  claude │  user / assistant bubbles, handoff cards,   │                              │
│     ⎇ main ↑1  ★     │  system lines, markdown-lite rendering      │  panel content (S5 / S2) or  │
│   ◐ Hacker   gemini  │                                            │  a placeholder               │
│ ▸ Ungrouped          │ status: Worker A đang suy nghĩ… · đã chạy   │                              │
│ [+ Agent] [+ Group]  │ 1m12s · <task> · [Dừng]                     │                              │
│ [Thiết lập đội]      │ queue chip: "2 mục đang chờ" ▾              │                              │
│                      │ composer: textarea · platform/model/effort  │                              │
│                      │ · 📎 · [Gửi] (Ctrl+Enter)                   │                              │
└──────────────────────┴────────────────────────────────────────────┴──────────────────────────────┘
```
- Status dots: idle (grey), thinking (accent, pulsing), waiting (warn), error (err), needs-login (err ring + "Đăng nhập lại" chip that calls S3 when present).
- Drag an agent onto a group header to move it (HTML5 drag and drop, `ws_agent_move`); keyboard alternative in the context menu ("Chuyển nhóm").
- Collapsing a group persists (`ws_group_save { collapsed }`).
- Top bar `+added −removed`: from the agent's workdir `git_info` (`modified_count`) — exact line counts come from S1 `worktree_diff` / S5 when present, else "n tệp".
- Context meter: `conversation.context.pct`, warn ≥ 60 %, err ≥ 70 %; tooltip with tokens and "Nén ngay" (`chat_compact`).
- Status line timer ticks every second from `active_started_at`.
- Polling: `chat_get?after_seq` every 1.5 s while the open conversation is busy, 6 s otherwise; `ws_state` on every `data` event and every 5 s while the view is visible. Nothing polls while the view is hidden.
- Mobile (< 900 px): the three columns become tabs "Agents | Chat | Panel".
- Themes: only CSS variables of `index.html` (`--surface`, `--accent`, …) plus `[data-skin="neon"]` accents.

### 8.3 Right column panels
- `Handoffs` (always present): "ĐANG CHỜ (n)" list (started / running with timers), finished cards with the structured result (status badge, summary, files, evidence collapsible, blockers, cost, scope violations, actions: accept / retry / cancel / open member chat / merge (S1)). At the bottom: the **Lead summary table rendered from the records** (role, agent, status, duration, files, cost).
- `Memory` (N7, always present): the entries of the agent's project `decisions.md` with search, add, edit, pin / unpin and delete (confirm). Every finished assistant message has "Lưu vào bộ nhớ dự án", which opens the same editor prefilled.
- `Files` (S5), `History`, `Auto Run` (S2): rendered by whatever registers through `MAW.ws.addPanel`; else a placeholder card "Chưa có — cần luồng S5/S2". `History` falls back to our own data: the agent's turns (time, platform, actual model, status, cost).
- Toast on every handoff that becomes terminal: "Handoff h_1a2b · Worker A xong (2m10s): <summary 80 chars>".

### 8.4 `MAW.ws` (public, for other streams)
```js
MAW.ws = {
  addPanel({ id, title, render(el, ctx) }),   // ctx = { agent, conversation, project_path }; called on selection change
  selectAgent(id), openConversation(id),
  current() → { agent, conversation },
  openTeamBuilder(), openAgentEditor(id?),   // set by feat-teams.js / feat-workspace.js
}
```
Other streams register a panel with:
`(MAW.ws ? MAW.ws.addPanel(p) : (window.MAW_WS_PANELS ||= []).push(p))`.
Events emitted on `document` as `CustomEvent`s (there is no public `MAW.emit`): `maw:handoff-done` `{ detail: handoff }`, `maw:agent-select` `{ detail: { agent_id } }`. When `MAW.emit` exists (Request R3), the same names are emitted there too (`handoff-done`).

### 8.5 V8 context menu (right click or `⋯` on an agent; keyboard: Shift+F10 / ContextMenu key)
Rename · Edit agent · Role setup (opens the team builder on its role) · Duplicate · Bookmark / Unbookmark · Move to group ▸ · ── · Git log · Git diff · Git pull · Git push (confirm) · Switch branch ▸ · Create PR (confirm) · Configure worktree · ── · Copy agent id · Delete (confirm, undo toast 8 s).
- Git entries call S1 `git_log` / `git_diff` / `git_pull` / `git_push` / `git_branch_switch` and S2 `github_pr_create` and are **hidden** when the action is missing (checked against `status.features`: `worktrees` ⇒ git actions, `github` ⇒ PR). Output appears in a modal.
- Group header menu: Rename · Collapse / Expand · Delete group (confirm: "agents move to Ungrouped").

### 8.6 N11 command palette (`feat-palette.js`)
- Ctrl+K / Cmd+K anywhere (a capture-phase `keydown` listener on `window` that stops the event, so the built-in project switcher's Ctrl+K handler does not also fire — see Request R1). Esc closes; ↑ ↓ PgUp PgDn Enter; focus trap; `role="dialog"` + `aria-activedescendant`.
- Sources (each item `{ group, label, hint, keywords, run() }`):
  - **Actions**: open Workspace / Dashboard view, new agent, new conversation, team builder, readiness check, refresh, switch theme / language, stop the current turn.
  - **Agents** (`ws_state`), **Conversations** (`chat_list` without agent, cached 10 s), **Projects** (`MAW.state.data.projects`; choosing one sets `#projectSel` and dispatches `change`, exactly like the built-in switcher), **Team templates** (`team_templates`), **Tasks** (S2 `task_list`, only when `tasks` is in `status.features`).
  - Other features can add items: `MAW.palette.addSource({ id, title, items: async () => Item[] })`.
- Fuzzy match: subsequence scoring (consecutive and word-start bonuses), diacritics-insensitive (`normalize('NFD')`), max 60 results, grouped.

### 8.7 i18n
Every string through `MAW.addI18n('vi' | 'en', …)` with an `ws`-prefixed key; re-render on the `lang` event.

---

## 9. Requests to Tech Lead

- **R1 — Ctrl+K.** `index.html` binds Ctrl+K to the project switcher (`document` keydown). S6's palette captures it first on `window` (capture phase) and offers projects as a source. Please remove that handler (or guard it with `if (window.MAW?.palette) return;`) when merging, and optionally expose `MAW.selectProject(path)` so the palette does not have to drive `#projectSel` directly.
- **R2 — `mode: "chat"` + resume in the runner.** Accept `mode: "chat"` in `validate.ts` / `commands.ts` as `task` plus `{ agent_profile_id, conversation_id, resume_token }` → `invoke-agent.ps1 -ResumeId <token>`, mapped per adapter: Claude `--resume <id>`, Codex `exec resume <id>`, Gemini `--resume <id>`, Antigravity `-Action send -ConversationId <id>`; registry `cli.resume_args` for generic CLIs (same need as S5 steer). Also pass `cli_args[]` and `env{}` of an agent profile through (argument array / child env). When this lands, add `"chat-resume"` to `status.features`; S6 then sends resume tokens instead of replaying history.
- **R3 — `MAW.emit(event, data)`** (or a documented `emit` for features) so `handoff-done` reaches S3 through `MAW.on`. Until then S6 dispatches `document` `CustomEvent('maw:handoff-done')`.
- **R4 — Test glob.** `npm test` runs `server/tests/*.test.ts` only. Please extend it to `server/tests/*.test.ts server/features/*/tests/*.test.ts` (S6 tests live in `server/features/<name>/tests/`).
- **R5 — Leader role for chat.** The runner's task roles exclude `leader`, so the S6 Lead runs as `architect` with the S6 dispatch-tool brief. Fine for now; a `leader`-in-chat mode would need `MAW_DEPTH` handling.
- **R6 — `.gitignore`.** Suggest documenting that projects may ignore `.maw/attachments/` (kept out of the repo) while `.maw/team.json`, `.maw/roles/` and `.maw/memory/` are meant to be committed.
- **R7 — Registry `context_window`** (optional) per agent, replacing the constant table in §3.3.
- **R8 — Bug in `invoke-cli-agent.ps1`: output lines are reordered.** It reads stdout / stderr with `Register-ObjectEvent … OutputDataReceived` actions that push into a queue; PowerShell runs those actions out of order, so a multi-line reply arrives scrambled in the job log. Reproduced with a fake `text`-mode CLI that prints `Plan…`, a fenced block opener, a JSON line and the fence closer: the log had the lines in another order, which breaks every fenced block (S6 handoffs, reviewer `VERDICT` lines, code blocks). Suggested fix: read stdout synchronously on a dedicated thread (`$proc.StandardOutput.ReadLine()` loop in a runspace) or tag each line with a sequence number and sort before writing. S6 tests use the `gemini-json` output mode, which is not affected.
- **R9 — Expose `MAW.selectProject(path)`** (see R1) and `MAW.relogin(platform)` from S3, which the S6 "Đăng nhập lại" chip calls when present.

## 10. Tests (Antigravity, `server/features/<name>/tests/*.test.ts`, run with `node --test`)
- Log parser fixtures (Claude, Codex, Antigravity, generic, failed, auth error).
- Prompt builder: order, 17 000-char cap, trimming order, Lead dispatch instructions only for may-delegate roles.
- Handoff block parser and result validator (valid, invalid JSON, wrong types, missing block, oversize fields).
- Role-md parse / render round trip (EN + VI headings, unknown sections kept); decisions.md parse / add / update / delete round trip with hand-written content.
- Store: create / update / soft delete / restore / duplicate / move / group delete moves agents out; validation errors (bad platform, model, workdir outside projects root, env deny list).
- Chat lifecycle with a fake `startJob` (writes a fake meta + log): send → tick → assistant message; busy → queue → next turn after finish; platform switch ⇒ new session; compaction trigger; retry policy.
- Handoff lifecycle with a fake `startJob`: Lead reply with a handoff block → records → member jobs → results → Lead `handoff` messages → auto-continue message; `needs_review` on a bad block; write-scope violation.
- Every action through the real HTTP server (feature loading): 200 shapes, 400 / 404 / 409 cases, POST security still enforced.
