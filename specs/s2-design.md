# S2 — Board: detailed design (stream lead: Claude)

Covers N1/#4 task board, #5 retry / reassign / resume, #6 templates + team presets, V10 Auto Run playbooks, N9 scheduled runs, N13 GitHub via `gh`.
Built on F0 (SPEC §9.0). Every rule of SPEC §3.0 (security, 256 KB body, JSON errors) applies to every action below.

## 0. Ownership and layout

| Path | Owner | Content |
| :--- | :--- | :--- |
| `server/features/tasks/**` | Antigravity | cards store, scheduler, templates, presets, concurrency config, ticker registry |
| `server/features/playbooks/**` | Antigravity | markdown checklist → cards, tick boxes |
| `server/features/schedules/**` | Antigravity | cron-like schedules |
| `server/features/github/**` | Antigravity | `gh` wrapper, issue import, PR create, PR feedback |
| `server/features/*/tests/*.test.ts` | Antigravity | `node --test` suites for the four features |
| `dashboard/feat-tasks.js` / `.css` | Claude | Board view, card editor, templates / presets, Auto Run, schedules, settings |
| `dashboard/feat-github.js` | Claude | GitHub status pill, issue import, PR actions on cards (plugs into feat-tasks) |
| `specs/s2-*.md` | Claude | this file |

No script hooks are needed (`scripts/hooks/*/20-task*.ps1` stays empty): the scheduler watches job metas, which the runner already writes.

Features read and write only their own data folder (`ctx.paths.featureDataDir(name)`). Playbooks, schedules and GitHub create / read cards **in process** through the functions exported by `server/features/tasks/store.ts` — never by touching `data/tasks/` themselves.

Common helpers (in `server/features/tasks/lib.ts`, imported by the other three):
- `readJson(file, fallback)` / `writeJsonAtomic(file, data)` (write `*.tmp` + `renameSync`; on Windows retry the rename up to 5× on `EPERM`/`EBUSY`);
- an async **mutex per file** so concurrent requests and the scheduler never lose writes;
- `newId(prefix)` = `<prefix>_<yyyymmddhhmmss>_<6 hex>`;
- `badRequest(msg)` = `new ApiValidationError(msg, 400)`, `notFound`, `conflict` (409).
- `appendAudit(ctx, entry)` → `appendAuditEntry(ctx.paths.auditFile, { Timestamp, Tool: 'maw-board', Action, ... })` for every destructive or outward action (delete, cancel, playbook file write, git push, PR create).

## 1. N1 — Task board

### 1.1 Card
```jsonc
{
  "id": "task_20261025093000_a1b2c3",
  "title": "Login page",                       // 1..200 chars
  "prompt": "Build the login page …",          // 1..20000 chars (same limit as run_job)
  "project_path": "C:\\laragon\\www\\shop",     // validated with resolveProjectPath (same rule as run_job)
  "mode": "task",                               // task | team | council | auto-gate | chat
  "agent": "claude",                            // task: executing agent; team: leader; auto-gate: implementer; council: "" (uses reviewers)
  "role": "frontend",                           // task: architect|backend|frontend|reviewer|tester; team: "leader"; others: ""
  "team": { "backend": "antigravity", "reviewer": "codex" },   // team mode only (optional, preset fills it)
  "reviewers": ["claude", "codex"],             // council / auto-gate only (optional)
  "model": "", "effort": "",                    // optional overrides, validated by run_job
  "preset_id": "",                              // optional (§3.2); applied when the card starts
  "isolate": false,                             // passed to ctx.startJob (S1 worktree); preset may set it
  "depends_on": ["task_…"],                     // ids of cards that must be `done` first; no cycles
  "priority": 0,                                // -2..3, higher starts first
  "require_review": false,                      // true: a successful job moves the card to `review`, not `done`
  "status": "backlog",                          // backlog | queued | running | needs_input | review | done | failed
  "status_reason": "",                          // short text: "rejected (exit 2)", "cancelled", "blocked by task_…", …
  "job_id": null,                               // current / last job
  "attempts": [ /* §2.1 */ ],
  "retry": { "auto": false, "max_attempts": 3, "backoff_sec": 60 },
  "next_retry_at": null,                        // ISO, set when an auto retry is pending
  "labels": ["ui"],
  "source": null,                               // { "kind": "github-issue"|"github-pr"|"playbook"|"schedule", ... } see §4–§6
  "created_by": "user",                         // user | lead | github | playbook | schedule
  "created_at": "2026-10-25T09:30:00.000Z",
  "updated_at": "…",
  "started_at": null, "finished_at": null,
  "order": 1000,                                // position inside its column (drag & drop)
  "pending_run": null,                          // one-shot { kind: retry|resume|auto-retry, prompt, new_session? } set by task_retry / auto-retry, consumed by the next start
  "starting": null,                             // { at, prompt_sha } written just before ctx.startJob; a stale one is reconciled after a restart (§1.3)
  "pr": null                                    // { number, url } once github_pr_create finished
}
```
Validation on create / update (400 with a clear message):
- `mode` in the list; for `task` the agent must be an enabled registry id and the role a task role; `team` needs a leader agent; `auto-gate` / `council` reviewers must be enabled registry ids with `capabilities.review`. Final validation is still done by `run_job` when the card starts (its error becomes the attempt error).
- `depends_on`: existing ids, not itself, **no cycle** (DFS over the whole graph), max 20.
- `mode: "chat"` is stored, but starting it calls `ctx.startJob({ mode: 'chat', … })`; until S6 adds that mode to the runner the attempt fails with the runner's message. (Documented, not hidden.)

Storage: `data/tasks/tasks.json` = `{ "version": 1, "tasks": [Card, …] }` (max 2000 cards; `done` cards older than 30 days are pruned on start). One file + mutex keeps cross-card operations (dependencies, ordering) atomic.

### 1.2 Status flow
```
backlog ──move/start──▶ queued ──scheduler──▶ running ──job DONE, exit 0──▶ done   (or review when require_review)
   ▲                      ▲                      │──job exit 124──────────▶ needs_input  ("agent still working / timed out")
   │                      │                      │──job FAILED/exit≠0─────▶ failed       (exit 2 ⇒ reason "rejected")
   └──────move────────────┴──retry / auto-retry──┘──job CANCELLED─────────▶ failed       (reason "cancelled", no auto-retry)
review ──approve (move to done)──▶ done          review ──reject──▶ failed (reason "rejected by user") ⇒ retry
```
- `task_move` may set any status **except** `running` (only the scheduler or `task_start` does that). Moving a `running` card requires `task_cancel` first (409 otherwise).
- Moving to `queued` clears `status_reason`.

### 1.3 Scheduler (in the server process)
- One loop per server process, `setInterval(tick, 3000).unref()`, plus an immediate tick (debounced 200 ms) after every mutation.
- **Leader lock**: `data/tasks/scheduler.lock` = `{ pid, started_at, heartbeat_at }`. A process runs the loop only if the lock is missing, its `pid` is no longer running (`isProcessRunning`), or its heartbeat is older than 20 s. The holder rewrites `heartbeat_at` every tick. Others stay passive (the UI still works; `status.feature_data.tasks.scheduler.active = false`). This matters because the main checkout server and worktree servers share `~/.maw`.
- **Start** (until the Tech Lead adds a lifecycle hook — see Requests): `ensureScheduler(ctx)` is called from the feature's `status()` and from every S2 route; idempotent. In addition `server/features/tasks/index.ts` auto-starts the scheduler at module load **only** when `process.argv[1]` ends with `server\main.ts` / `server/main.ts` and `MAW_BOARD_AUTOSTART !== '0'` (paths from `resolveServerPaths({ projectsRoot })`, `--projects-root` read from argv the same way `main.ts` does). Unit tests never auto-start; they call `tick()` directly.
- Each tick, in order:
  1. **Reconcile running cards**: read `<jobsDir>/<job_id>.json`, `refreshJobMetaStatus`, then map (§1.2). Missing meta ⇒ `failed` "job record missing". Close the current attempt (`finished_at`, `status`, `exit_code`).
  2. **Auto-retry**: `failed` cards with `retry.auto`, reason not "cancelled", `attempts.length < max_attempts`: if `next_retry_at` is empty set it to `now + backoff_sec * 2^(attempts-1)` (cap 3600 s); when due ⇒ `queued` with findings (§2).
  3. **Start queued cards** sorted by `priority desc, order asc, created_at asc`:
     - every `depends_on` card is `done` — else skip; if a dependency is `failed` set `status_reason: "blocked by <id> (failed)"`;
     - concurrency (§1.4) has room for every agent the card uses;
     - build the run body (§1.5) and `await ctx.startJob(body)`. Success ⇒ `running`, `job_id`, new attempt. A thrown `ApiValidationError` / error ⇒ `failed` with the message (no auto-retry for validation errors: `status_reason` starts with `"invalid: "`).
  4. Run the registered **tickers** (`registerTicker(name, fn)`: playbooks, schedules, github), each in try/catch.
- Idempotent after a restart: `running` cards are reconciled from job metas (a job started by a previous server keeps running and is still mapped), `queued` cards simply start again. Before `startJob` the card records `starting: { at, prompt_sha }`; right after, one locked write (`patchCard`) sets `running` + `job_id` and clears it. A `starting` older than 30 s (server died in between) is reconciled by matching job metas (project + prompt-file hash); with no match the card fails with "start interrupted" — a second job is never started automatically.
- All scheduler / ticker writes go through `patchCard(ctx, id, fn)` on the fresh copy under the mutex (no lost user edits, never re-inserts a deleted card). An in-process guard plus the fresh-status check prevent a double start between `task_start` and the scheduler.
- Leader lock (as built): exclusive create (`wx`) with a random token; a lock whose pid is dead or whose heartbeat is older than 60 s is renamed aside and re-claimed; the heartbeat is refreshed during the tick.

### 1.4 Concurrency limits
`data/tasks/config.json`:
```json
{ "version": 1, "max_parallel": 3, "per_agent": { "antigravity": 1, "claude": 2 }, "paused": false }
```
- `max_parallel` 1..16 (running cards in total). `per_agent[<registry id>]` 0..16 (0 = never start). Missing id ⇒ no per-agent limit.
- Agents a card uses: `task` → agent; `team` → leader + team values; `council` → reviewers (or `defaults.council`); `auto-gate` → implementer + reviewers (or defaults); `chat` → agent.
- `paused: true` stops step 3 only (running cards are still reconciled).
- Only cards started by the board count (manual Run-button jobs are not limited — they are the user's explicit choice).

### 1.5 Card → run body
```
{ mode, project_path, prompt: <rendered prompt>, agent?, role?, team?, reviewers?, implementer?, model?, effort?,
  new_session?: true (when the card is from a playbook and the agent has capabilities.new_session), isolate?, budget_usd?, max_rounds? }
```
- `auto-gate`: `implementer = card.agent`, `reviewers`.
- Preset (§3.2) fills empty fields: `team`, `reviewers`, `implementer`, `isolate`, `max_rounds` (from `max_fix_rounds`), `budget_usd`. Card fields win over the preset.
- `isolate`, `budget_usd`, `max_rounds` are passed through for S1 / S4; the current runner ignores unknown keys.

### 1.6 Actions (feature `tasks`)
| Action | Method | Request | Response |
| :--- | :--- | :--- | :--- |
| `task_list` | GET | `?project_path=&agent=&status=` (all optional) | `{ ok, tasks: Card[], config, scheduler: { active, pid, last_tick_at }, counts: { <status>: n } }` |
| `task_get` | GET | `?id=` | `{ ok, task, log_tail }` (`log_tail` = last 4 KB of the current job log) |
| `task_create` | POST | card fields (`title`, `prompt` required unless `template_id`) + optional `template_id`, `vars: {}`, `status: "backlog"\|"queued"` (default `backlog`), `created_by` (`user` default; `lead` allowed from the API) | `{ ok, task }` |
| `task_update` | POST | `{ id, …fields }` (not while `running`, except `title`, `labels`, `priority`, `retry`) | `{ ok, task }` |
| `task_delete` | POST | `{ id }` (not `running` ⇒ 409; removes the id from other cards' `depends_on`) | `{ ok, id }` + audit |
| `task_move` | POST | `{ id, status, before_id?, reason? }` (reorders `order` inside the target column; `reason` ≤ 200 chars becomes `status_reason`, e.g. "rejected by user") | `{ ok, task }` |
| `task_start` | POST | `{ id, ignore_limits?: bool }` — dependencies must be `done` (409 otherwise); starts now | `{ ok, task, job_id }` |
| `task_cancel` | POST | `{ id }` — cancels the running job (`handleCancelJob`) ⇒ `failed` "cancelled" | `{ ok, task }` + audit |
| `task_retry` | POST | §2.2 | `{ ok, task }` |
| `task_config_save` | POST | `{ max_parallel, per_agent, paused }` | `{ ok, config }` |
| `task_bulk_create` | POST | `{ tasks: [ {…, "ref": "a", "depends_on_refs": ["b"]} ], created_by }` (≤ 50; refs resolve to the new ids) — used by Lead plans (S6) | `{ ok, tasks }` |

`task_create` / `task_bulk_create` are the public contract for S3 (Telegram), S6 (Lead plans) and schedules.

`status.feature_data.tasks` = `{ counts, running, queued, scheduler: { active, pid, last_tick_at }, config }` (small; the board loads `task_list` itself).

## 2. #5 — Retry / reassign / resume

### 2.1 Attempt
```json
{ "n": 1, "job_id": "job_…", "agent": "claude", "role": "frontend", "mode": "task", "kind": "start|retry|resume|auto-retry",
  "started_at": "…", "finished_at": "…", "status": "DONE|FAILED|CANCELLED|RUNNING|ERROR", "exit_code": 0, "error": "",
  "score": 7.5, "verdict": "CHANGES_REQUESTED", "findings": "…≤ 6000 chars…" }
```
When an attempt closes, the scheduler reads the job log tail (last 64 KB, ANSI stripped) and stores:
- `score` / `verdict`: the **last** `SCORE: X/10` / `VERDICT:` lines (SPEC §4);
- `findings`: for reviewer-like modes (council, auto-gate, reviewer role) the text from the last `=== COUNCIL_RESULT` or the last reviewer block to the end; otherwise the last 3000 chars. Max 6000 chars.

At most 20 attempts are kept per card (oldest dropped).

### 2.2 `task_retry`
Request: `{ id, agent?, role?, mode?: "retry"|"resume", include_findings?: true, note?: "" }`
- Allowed for `failed`, `review`, `needs_input` (and `done`, as "run again"); 409 for `running`.
- `agent` / `role` given ⇒ **reassign** (validated like create; saved on the card).
- Prompt for the new attempt = `card.prompt` + (when `include_findings` and the last attempt has findings)
  `\n\n---\n## Previous attempt #<n> (<agent>, <status>, exit <code>, <score>)\nFix every finding below.\n<findings>` + (`note` ⇒ `\n\n## Note from the user\n<note>`). The card's own `prompt` is not modified; the rendered prompt is stored on the attempt as `prompt_chars`. Total capped at 20000 chars (findings truncated first).
- `resume`: only for an agent with `capabilities.sessions` (Antigravity): the job runs with `new_session: false` so it continues in the latest conversation of that workspace, prompt = note or "Continue the task and report when done."; other agents ⇒ 400 "resume needs an agent with sessions; use retry".
- The card goes to `queued` (so dependencies / limits still apply); `next_retry_at` cleared.

## 3. #6 — Templates and team presets

### 3.1 Prompt template
```json
{ "id": "tpl_…", "name": "Implement feature", "builtin": true, "description": "",
  "title": "Implement {{feature}}", "prompt": "Implement {{feature}} in {{file}} following SPEC.md …",
  "mode": "task", "agent": "", "role": "backend", "preset_id": "", "labels": [] }
```
- Variables: `{{name}}` with `name` matching `^[a-z][a-z0-9_]{0,31}$`; `variables` (array of names) is derived on read. Rendering replaces every occurrence; a missing value ⇒ 400 `Missing template variable: file`. `{{project}}` and `{{date}}` are filled automatically.
- Built-ins (read-only, in code): `implement-feature`, `fix-bug`, `write-tests`, `security-review` (council), `refactor-file`, `review-uncommitted` (council).
- User templates: `data/tasks/templates.json` (max 200).

### 3.2 Team preset
```json
{ "id": "preset_…", "name": "Default team", "builtin": true, "description": "",
  "team": { "backend": "antigravity", "frontend": "claude", "reviewer": "codex" },
  "leader": "claude", "implementer": "antigravity", "reviewers": ["claude", "codex"],
  "max_fix_rounds": 2, "budget_usd": 0, "isolate": false }
```
- Built-ins: `default` (from `registry.defaults`), `solo-claude`, `strict-council` (3 reviewers that are enabled, `max_fix_rounds` 3, isolate on). Agent ids are filtered to enabled registry ids on read.
- User presets: `data/tasks/presets.json` (max 100). `max_fix_rounds` 0..5, `budget_usd` 0..1000 (0 = none).

### 3.3 Actions
| Action | Method | Request / response |
| :--- | :--- | :--- |
| `template_list` | GET | `{ ok, templates: [ …, variables ] }` (built-ins first) |
| `template_save` | POST | template without `builtin` (`id` absent ⇒ new; a built-in id ⇒ 409 "built-in templates are read-only") ⇒ `{ ok, template }` |
| `template_delete` | POST | `{ id }` ⇒ `{ ok, id }` (built-in ⇒ 409) + audit |
| `preset_list` / `preset_save` / `preset_delete` | GET / POST / POST | same pattern ⇒ `{ ok, presets }` / `{ ok, preset }` / `{ ok, id }` |
| `library_export` | GET | `{ ok, library: { "maw_library": 1, "exported_at", "templates": [user…], "presets": [user…] } }` |
| `library_import` | POST | `{ library, overwrite?: false }` ⇒ `{ ok, imported: { templates, presets }, skipped: [ "<id>: reason" ] }`. Same validation as save; ids that exist are skipped unless `overwrite`; built-in ids always skipped. |

## 4. V10 — Auto Run playbooks (feature `playbooks`)

- A playbook is a markdown file. Tasks are list lines `- [ ] text` / `* [ ] text` (any indentation; `[x]`/`[X]` = already done). An item's text may continue on following lines indented deeper than the bullet (joined with `\n`). Headings above an item are kept as context: the card prompt is `<item text>` + `\n\nContext: playbook <file>, section "<nearest heading>".` + the optional run `prefix`.
- Allowed files: `<project>/.maw/playbooks/*.md` (listed) or any `.md` path **inside** the project (`fs.realpathSync` + case-insensitive prefix check, no `..`, ≤ 512 KB).
- Run state `data/playbooks/runs.json`: `{ id, project_path, file, on_failure: "stop"|"continue", status: running|done|stopped|failed, items: [{ line, text, card_id, state: pending|running|done|failed|skipped }], cursor, created_at, finished_at }`.
- `playbook_run` creates **all** cards up front in `backlog` (`created_by: "playbook"`, `source: { kind: "playbook", run_id, file, line }`, `new_session` when supported). The playbook ticker queues the item at `cursor` only when no item of that run is running, so items run strictly in order, one at a time, each in a fresh session.
- When an item's card becomes `done`: tick its box in the file (re-read the file, find the line; if the text moved, search for the same unchecked text; replace only `[ ]` → `[x]` on that line; keep BOM and line endings; atomic write; audit line). Then advance.
- Card `failed`: `stop` ⇒ run `failed`, remaining cards stay in backlog with `status_reason: "playbook stopped"`; `continue` ⇒ mark failed and advance. A retried card that later becomes `done` still ticks its box.
- `playbook_stop { run_id }` ⇒ `stopped`; its backlog cards are left for the user.

| Action | Method | Request / response |
| :--- | :--- | :--- |
| `playbook_list` | GET | `?project_path=` ⇒ `{ ok, dir: "<project>\\.maw\\playbooks", files: [{ file, name, total, done, mtime }] }` |
| `playbook_preview` | GET | `?project_path=&file=` ⇒ `{ ok, file, items: [{ line, text, checked, section }] }` |
| `playbook_run` | POST | `{ project_path, file, mode, agent, role, preset_id?, on_failure, prefix?, include_checked?: false }` ⇒ `{ ok, run, tasks }` (0 unchecked items ⇒ 400) |
| `playbook_runs` | GET | `?project_path=` ⇒ `{ ok, runs }` (latest 50) |
| `playbook_stop` | POST | `{ run_id }` ⇒ `{ ok, run }` |

## 5. N9 — Scheduled runs (feature `schedules`)

```json
{ "id": "sch_…", "name": "Nightly council review", "enabled": true,
  "when": "daily 02:00",                          // daily HH:MM | weekly mon..sun HH:MM | every N minutes (5..1440)
  "action": { "type": "card", "card": { "title": "…", "prompt": "…", "project_path": "…", "mode": "council", … , "status": "queued" } }
        // or { "type": "playbook", "project_path": "…", "file": "…", "mode", "agent", "role", "on_failure" }
  "skip_if_running": true,                        // don't create a new card while the previous one is queued/running
  "last_run_at": null, "next_run_at": "…", "last_result": "created task_… | skipped (previous still running) | error: …" }
```
- Times are **local server time**. `next_run_at` is computed on save and after every run.
- Ticker: for each enabled schedule with `next_run_at <= now` ⇒ run once, then compute the next time **from now** (so a long downtime gives exactly one catch-up run). On start the first tick does this naturally ⇒ "missed while down ⇒ caught up once".
- Created cards: `created_by: "schedule"`, `source: { kind: "schedule", schedule_id }`, `status: "queued"`.
- Storage `data/schedules/schedules.json` (max 50).

| Action | Method | Request / response |
| :--- | :--- | :--- |
| `schedule_list` | GET | `{ ok, schedules, now }` |
| `schedule_save` | POST | schedule (without `last_*`) ⇒ `{ ok, schedule }`; invalid `when` ⇒ 400 with the accepted forms |
| `schedule_delete` | POST | `{ id }` ⇒ `{ ok, id }` + audit |
| `schedule_run_now` | POST | `{ id }` ⇒ `{ ok, schedule, result }` |

## 6. N13 — GitHub via `gh` (feature `github`)

- Every call: `execFile('gh', [...args], { cwd: project_path, windowsHide: true, shell: false, timeout: 30000 })` (through `runCommand` from `server/lib/proc.ts` if it fits). `gh` env: `GH_PROMPT_DISABLED=1`, `NO_COLOR=1`.
- `gh` missing ⇒ every action returns `{ ok: false, error: "GitHub CLI (gh) is not installed." , gh: { installed: false } }` with **409**; not logged in ⇒ 409 "gh is not logged in. Run: gh auth login".
- Status cached 5 min: `gh --version`, `gh auth status --hostname github.com` (exit 0 ⇒ logged in; user parsed from output).

| Action | Method | Request / response |
| :--- | :--- | :--- |
| `github_status` | GET | `?project_path=` ⇒ `{ ok, gh: { installed, version, logged_in, user }, repo: { name_with_owner, url, default_branch } \| null }` (`gh repo view --json nameWithOwner,url,defaultBranchRef`; no remote ⇒ `repo: null`) |
| `github_issues` | GET | `?project_path=&state=open&limit=30&search=` ⇒ `{ ok, issues: [{ number, title, labels: [names], url, author, updated_at }] }` (`gh issue list --json number,title,labels,url,author,updatedAt --limit N [--search q] --state s`) |
| `github_issue_import` | POST | `{ project_path, number, mode?, agent?, role?, preset_id?, template_id?, status? }` ⇒ `{ ok, task }`. `gh issue view N --json number,title,body,labels,url`. Card: title `#N <title>`, prompt = template (default "Resolve GitHub issue #{{number}}: {{title}}\n\n{{body}}"), labels from the issue, `created_by: "github"`, `source: { kind: "github-issue", number, url }`. Importing the same issue twice ⇒ 409 with the existing card id. |
| `github_prs` | GET | `?project_path=` ⇒ `{ ok, prs: [{ number, title, head, url, review_decision, checks: "pass"\|"fail"\|"pending"\|"none" }] }` |
| `github_pr_create` | POST | `{ task_id, branch?, base?, draft?: false, ai_description?: true, reviewer_agent? }` (§6.1) ⇒ `{ ok, pr_request }` |
| `github_pr_requests` | GET | ⇒ `{ ok, requests }` (latest 50) |
| `github_pr_feedback` | POST | `{ project_path, number, agent?, role?, mode?, status? }` (§6.2) ⇒ `{ ok, task, counts: { reviews, comments, failed_checks } }` |

### 6.1 Approved card → PR
1. Allowed when the card is `review` or `done` (409 otherwise). Branch = `branch` ‖ the card's S1 worktree branch (`attempts[-1].branch` if S1 records one) ‖ `git rev-parse --abbrev-ref HEAD` in `project_path`. Refuse when the branch equals the base / default branch (400 "create a branch first").
2. Record `data/github/pr_requests.json` `{ id, task_id, project_path, branch, base, state: describing|pushing|creating|done|failed, job_id, pr_url, error }`.
3. `ai_description` ⇒ start a describer job via `ctx.startJob({ mode: 'task', agent: reviewer_agent ‖ preset reviewer ‖ defaults.team.reviewer, role: 'reviewer', project_path, prompt })` where the prompt asks for a PR description of `git diff <base>...<branch>` with sections Summary / Changes / Testing, ending with a line `=== PR_BODY_END ===`. The GitHub ticker waits for the job; body = text between `=== PR_BODY_START ===` and `=== PR_BODY_END ===` (fallback: last 4000 chars of the log); failure ⇒ fall back to the card prompt + attempt summary (never blocks the PR).
4. `git push -u origin <branch>` (argument array, audit line), then `gh pr create --head <branch> --base <base> --title <card title> --body-file <tmp file> [--draft]`; PR URL parsed from stdout ⇒ saved on the request and on the card (`card.pr = { number, url }`).

### 6.2 PR feedback → fix card
`gh pr view N --json number,title,url,headRefName,reviews,comments,statusCheckRollup` + `gh api repos/{owner}/{repo}/pulls/N/comments` (inline review comments: path, line, body). Fix card prompt:
```
Fix the review feedback on PR #N "<title>" (branch <head>).
## Review comments
- <path>:<line> — <body> (@author)
## Reviews requesting changes
- @author: <body>
## Failed checks
- <name>: <conclusion> <details url>
```
`created_by: "github"`, `source: { kind: "github-pr", number, url, branch }`. Nothing to fix (no comments, no failed checks) ⇒ 400 "PR #N has no review comments or failed checks".

## 7. UI (Claude) — `dashboard/feat-tasks.*`, `dashboard/feat-github.js`

- `MAW.addView({ id: 'board', title: 'Board' })` — full-width view. Header row: project filter (all / current project), agent filter, search, `+ Card`, scheduler pill (active / passive / paused, running n / max), and a sub-nav: **Board · Templates & presets · Auto Run · Schedules · Limits**.
- **Board**: 7 columns (Backlog, Queued, Running, Needs input, Review, Done, Failed). Horizontal scroll on narrow screens (columns 280 px, scroll-snap). Cards show title, agent chip (registry colour), mode / role, priority, labels, dependency badges ("⛓ waits on 2" / "blocks 1"), attempt count, last score, source icon (GitHub / playbook / schedule), elapsed time when running.
  - Drag & drop between columns (HTML5 DnD, `task_move` with `before_id`); keyboard fallback: card menu "Move to…". Running cards are not draggable.
  - Dependencies: hovering / focusing a card highlights its dependencies and dependants; an SVG overlay draws arrows between visible cards on desktop (≥ 900 px), hidden on mobile (badges remain).
- **Card drawer** (side panel / full screen on mobile): edit fields (template picker with variable inputs, preset, mode, agent, role, deps multi-select, priority, require review, auto-retry), attempts timeline (agent, status, score, findings collapsible, link "open log" ⇒ loads the job into the main live log via `MAW.showView('dashboard')` + job id), buttons: Start, Cancel (confirm), Retry, Retry on… (agent picker = reassign), Resume (only for agents with sessions), Approve / Reject (review column), Delete (confirm).
- **Templates & presets**: lists with built-in badge, editor forms, Export (downloads JSON), Import (file picker ⇒ `library_import`, shows skipped).
- **Auto Run**: playbook files of the current project with progress (done / total), preview list, run form (mode, agent, role, preset, stop / continue), runs list with per-item state, Stop (confirm).
- **Schedules**: list with next run (relative + absolute), enabled toggle, Run now, editor with `when` builder (daily / weekly / every) and action (card fields or playbook). Quick presets: "Nightly council review of uncommitted work", "Weekly security audit".
- **Limits**: max parallel, per-agent limits for every enabled registry agent, pause toggle.
- `feat-github.js`: GitHub pill (gh installed / logged in / repo), "Import issue" (toolbar button + `MAW.addProjectAction`) ⇒ issue list dialog with search ⇒ import; card actions "Open PR" (review/done cards; confirm: shows branch → base and that it will push) and PR-request progress; "Import PR feedback" dialog (open PRs with check status) ⇒ fix card. Disabled with a clear reason when `gh` is missing or not logged in.
- Extension point between the two UI files: `window.MAW_BOARD = { addCardAction({ id, label, when(card), run(card) }), addToolbarButton({ id, label, run }), refresh(), openCard(id) }`.
- Also `MAW.addJobAction({ id: 'to-card', label: 'Add to board' })` on finished jobs ⇒ new card prefilled with the job's agent / role / project.
- Polling: `task_list` every 3 s while the Board view is visible (and on `job-end`), otherwise on the global `data` event. Bilingual through `MAW.addI18n('vi'|'en', …)`; light, dark and neon via the existing CSS variables (no new colours except per-agent `color` from the registry). All classes prefixed `tk-` (the page already has `.board`, `.slot`, …).
- Destructive actions (delete card, cancel, delete template / preset / schedule, stop playbook, push + PR) use a confirm dialog; the server writes the audit line.

## 8. Tests (Antigravity)
`server/features/<name>/tests/*.test.ts`, run with `node --test server/features/*/tests/*.test.ts` (see Requests). Each test uses a temp `MAW_HOME` / `mawHome` and a fake `startJob` (no real agents):
- tasks: create / validate / cycle rejection; scheduler starts only when deps are done; concurrency (global + per agent); status mapping (exit 0 / 2 / 124 / cancelled / missing meta); auto-retry backoff; retry prompt contains findings; reassign; resume rejected for agents without sessions; restart idempotency (new scheduler instance reconciles a running card); leader lock (second instance stays passive); templates render / missing var; built-in read-only; library export → import round trip.
- playbooks: parse (nested, checked, continuation lines, headings); path outside project rejected; run creates ordered cards; tick box rewrites only that line (CRLF + BOM preserved); stop vs continue.
- schedules: parse `when` forms + invalid; `next_run_at` daily / weekly / every; missed run caught up exactly once; skip_if_running.
- github: fake `gh` (a `.cmd` shim on a temp `PATH`, or an injectable runner) for missing gh ⇒ 409, not logged in ⇒ 409, issue import ⇒ card, duplicate import ⇒ 409, PR feedback ⇒ prompt with comments and failed checks, PR create flow (describer job ⇒ push ⇒ `gh pr create` argument arrays).
- One HTTP-level test through `createMawHttpServer({ mawHome, featuresDir: <repo>/server/features })`: `task_create` ⇒ `task_list` ⇒ `task_move`, and the §3.0 POST guard applies to a feature route.

## 9. Requests to Tech Lead
1. **Feature lifecycle hook**: add `start?(ctx): void | Promise<void>` and `stop?(): void` to `MawFeature`, called by `main.ts` after `listen` (and `stop` on shutdown), never by `createMawHttpServer` in tests. S2 then drops the argv-based auto-start in `server/features/tasks/index.ts` and exports `start` on the feature.
2. **`npm test` glob**: include feature tests: `node --test server/tests/*.test.ts server/features/*/tests/*.test.ts`.
3. **`ctx.cancelJob(jobId)`** in `MawFeatureContext` (wrapping `handleCancelJob`). Until then S2 imports `handleCancelJob` from `server/actions/jobs.ts` directly.
4. **Runner pass-through**: `run_job` / `ctx.startJob` should keep `isolate` (S1), `budget_usd` / `max_rounds` (S4 / Auto-Gate `-MaxRounds`) and an optional `source: { feature: 'tasks', task_id }` in the job meta, so the timeline (S3) and inbox can link a job to its card.
5. **Mode `chat`** in the runner (S6) so `mode: "chat"` cards can start.
6. **Main live-log hook**: `MAW.openJob(jobId)` to show an existing job in the live log panel (the board's "open log" link). Until then the board shows its own log tail from `task_get`.
