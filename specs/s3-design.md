# S3 — Attention: detailed design (stream lead: Claude)

Scope: SPEC §9.1 row S3, `specs/streams/s3-attention.md`. Items in build order: **B2+B3** health / readiness → **V7** re-login → **N5** inbox → **N5** two-way Telegram → **N8** timeline + report → **N12** doctor → **N14** MCP config manager + dashboard MCP server.

Owned paths (nothing else is touched):

| Layer | Owner | Paths |
| :--- | :--- | :--- |
| Server features | Antigravity | `server/features/{health,inbox,telegram,timeline,mcp}/**` (incl. their `*.test.ts`) |
| MCP server | Antigravity | `server/mcp/**` |
| Script hooks | Antigravity | `antigravity/skills/claude-leader/scripts/hooks/{before-agent,job-start,job-finish}/30-*.ps1`, Pester `tests/S3*.Tests.ps1` |
| UI | Claude | `dashboard/feat-{health,inbox,timeline,mcp}.{js,css}` |
| Design | Claude | `specs/s3-*.md` |

Common rules for every action below: F0 feature routes (§3.0 security, `X-MAW-Request` on POST, JSON only, `ApiValidationError` ⇒ 400). Child processes only through `runCommand` (argument arrays, `shell: false`, `windowsHide`). Each feature reads / writes only `ctx.paths.featureDataDir('<name>')`. Writes are atomic (temp file + rename). No secret (Telegram token, MCP env values, emails / org names from `claude auth status`) is ever logged, returned or written to a test fixture.

---

## 1. B2 + B3 — `health` feature (free pre-flight / readiness)

### 1.1 Probes (no LLM tokens; verified 2026-10-25 on this machine)

| Agent | installed / version | login probe | logged-in rule | quota / rate-limit hint | actual model |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `claude` (2.1.308) | same detection as `versions.ts` (`claude.exe` on PATH, else `%APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe`) | `claude auth status` → JSON `{ loggedIn, authMethod, apiProvider, subscriptionType, email, orgName… }` | `loggedIn === true`. Keep only `authMethod`, `subscriptionType`; **drop email / org / ids** | recent job-log patterns (see 1.3) | `~/.claude/settings.json` `model`, else `"default"` |
| `codex` (0.163.0) | `versions.ts` | `codex login status` → `Logged in using ChatGPT` / `Logged in using an API key` / `Not logged in` | stdout+stderr matches `/logged in/i` and not `/not logged in/i` | newest `~/.codex/sessions/**/rollout-*.jsonl` (≤ 24 h old): last `token_count` event `rate_limits.primary|secondary.used_percent` + `resets_at` → `quota: { used_percent, resets_at, window }`; ≥ 90 % ⇒ `warn`, 100 % ⇒ `error` until `resets_at` | `~/.codex/config.toml` top-level `model = "…"` |
| `gemini` (0.64.0) | generic detect (npm `.cmd` shim) | no CLI command; config check: env `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI=true`, or `~/.gemini/settings.json` `security.auth.selectedType` (legacy `selectedAuthType`) — for `oauth-personal` also `~/.gemini/oauth_creds.json` must exist | any of these ⇒ logged in; none ⇒ `logged_out` with hint "run `gemini` once, or set GEMINI_API_KEY" | job-log patterns | settings `model.name`, else `"auto"` |
| `antigravity` | `agentapi.bat` (as `versions.ts`) | `getBridgeStatus(paths.bridgeFile)` from `status.ts` (bridge online + hub port) | bridge online ⇒ ok; bridge file missing / stale ⇒ `error` "Antigravity IDE is not running" | — | bridge / last conversation model if known, else `null` |
| `cursor` | generic detect | registry `status_cmd`, default `["cursor-agent","status"]` (**not verified**: not installed here) | exit 0 and no `/not (logged|signed) in/i` | — | `null` |
| `aider` | generic detect | none; env keys `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` present (names only) | any key ⇒ ok, none ⇒ `unknown` (warn, never block: aider may use a config file) | — | `null` |
| any other `cli` entry | generic detect | registry `status_cmd` when set | exit 0 ⇒ ok; non-zero + `/not (logged|signed) in|login required|unauthenticated|401/i` ⇒ `logged_out`; else `unknown` | job-log patterns | `null` |

- Every probe has a **5 s timeout**; all agents are probed **in parallel** (target: whole team in ~1 s when cached, ≤ 5 s cold).
- Probe outputs are never returned raw. Only a short sanitized `reason` (≤ 200 chars, emails / tokens / paths under the user profile redacted).

### 1.2 Result shape and cache
```jsonc
// one per agent
{ "id": "codex", "label": "Codex CLI", "platform": "codex",          // platform = adapter, or cli.command for cli agents
  "installed": true, "version": "0.163.0",
  "login": "ok" | "logged_out" | "unknown" | "n/a",
  "auth_method": "chatgpt" | null,
  "quota": { "used_percent": 42, "resets_at": "2026-10-25T14:05:00Z", "window": "5h" } | null,
  "model": "gpt-5.5" | null, "model_source": "override" | "cli-config" | "unknown",
  "status": "ok" | "warn" | "error",
  "reason": "Logged in using ChatGPT",
  "fix": { "kind": "login" | "install" | "start-ide" | null, "command": "codex login" },
  "checked_at": "2026-10-25T10:00:00.000Z", "ms": 412 }
```
- `status = error` when not installed, `login = logged_out`, Antigravity bridge offline, or quota exhausted before `resets_at`. `warn` for `login = unknown`, quota ≥ 90 %, or auth / rate-limit errors seen in jobs of the last 30 min.
- Cache: in memory **60 s** per agent, and persisted to `data/health/cache.json` (`{ agents: { <id>: result } }`) for the hook.

### 1.3 Recent-error hints
Scan the tails (last 16 KB) of job logs in `paths.jobsDir` of the last 30 min for the agent (meta `agent`). Patterns are shared with V7 (§2.1). `429|rate limit|overloaded|529|usage limit` ⇒ `warn` with "rate-limited 12 min ago".

### 1.4 Actions
- `GET health_check?agents=claude,codex&refresh=1&team=<json>`
  - `agents` (optional, comma list of enabled registry ids; unknown id ⇒ 400). Default: all enabled agents.
  - `refresh=1` bypasses the 60 s cache.
  - `team` (optional JSON object `{ role: agentId, … }` or `{ role: { agent, model } }`) ⇒ the response also has `team_rows: [{ role, agent, label, platform, model, model_source, status, reason }]`, with `model` = the override when given (`model_source: "override"`).
  - Response `{ ok, agents: [result…], team_rows?, summary: { ok, warn, error }, cached: bool, ms }`.
- `status` contribution `feature_data.health = { summary, checked_at, agents: { id: { status, login, reason } } }` from the cache only (never probes in `status`).

### 1.5 `before-agent` hook — `scripts/hooks/before-agent/30-health.ps1`
- Context: `agent, role, workdir, model, effort`.
- Skip when `$env:MAW_SKIP_HEALTH -eq '1'`.
- Read `$MAW_HOME/data/health/cache.json` (`MAW_HOME` = env or `~/.maw`). If the agent entry is ≤ 10 min old and `status = error` ⇒ `@{ Block = $true; Reason = "<label>: <reason>. Fix: <fix.command> (or 'Đăng nhập lại' in the dashboard)."; Agent = ...; Kind = 'health' }`.
- No fresh entry ⇒ a **minimal local probe** for that agent only: `Get-Command` for the command (installed) and, if the registry entry has `status_cmd`, run it through `Invoke-NativeProcess` with a 5 s timeout and the rule in 1.1. Only a definite "not installed" / "not logged in" blocks. Anything uncertain passes (fail-open).
- Never blocks for `warn`. S4 hooks (`40-*`) run after ours and handle fallback.

### 1.6 UI (`feat-health.js`) — tab "Sức khỏe / Health"
- **Team readiness**: button "Kiểm tra sẵn sàng" uses the team picked in the main form (or the registry default team) → table: role · agent (colour dot) · platform · actual model · status badge · reason · fix button.
- **All agents** grid: one card per agent with status dot, version, login, quota bar.
- Header item: a small dot (green / amber / red) with the worst status; click → Health tab.

---

## 2. V7 — Re-login flow (part of `health`)

### 2.1 Auth-error detection (`server/features/health/patterns.ts`, shared with inbox)
```ts
export const AUTH_PATTERNS: Record<string, RegExp[]> = {
  claude:      [/OAuth (session|token) (has )?expired/i, /Please run \/login/i, /Invalid API key/i, /authentication_error/i, /\b401\b.*(unauthori[sz]ed|auth)/i],
  codex:       [/Not logged in/i, /Please (run )?`?codex login`?/i, /401 Unauthorized/i, /token (has )?expired/i, /refresh token/i],
  gemini:      [/Please set an Auth method/i, /GEMINI_API_KEY.*(not set|missing)/i, /Login required/i, /\b401\b/],
  antigravity: [/unauthenticated/i, /sign in to Antigravity/i],
  '*':         [/\b401\b.*unauthori[sz]ed/i, /authentication (failed|required)/i, /not (logged|signed) in/i],
};
export const RATE_PATTERNS: RegExp[] = [/\b429\b/, /\b529\b/, /overloaded/i, /rate.?limit/i, /usage limit/i, /quota/i];
export function classifyLog(agent: string, text: string): 'needs_login' | 'rate_limited' | null;
```
- A job is `needs_login` when its status is `FAILED` and `classifyLog(meta.agent, tail16k) === 'needs_login'`. For team / council / auto-gate jobs the agent is taken from the matching log line when the text names one (else `meta.agent`).
- The job runner's own status stays `FAILED` (shared file). `needs_login` is an **attention flag** owned by S3, exposed in `feature_data.inbox.job_flags[job_id] = "needs_login" | "rate_limited" | "needs_input" | "blocked"`.

### 2.2 Actions
- `POST login_open { agent }`
  - The agent must be enabled.
  - Command = registry `login_cmd`, else built-ins: `claude → ["claude","/login"]`, `codex → ["codex","login"]`, `gemini → ["gemini"]`, `cursor → ["cursor-agent","login"]`. `antigravity` / `aider` ⇒ 400 `"<label> has no login command."`.
  - The first element is resolved to a full path where we know it (`claude.exe` as in 1.1, npm shims).
  - Opens a **real visible terminal**: `runCommand('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand', <b64>])`, where the encoded launcher is `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit','-Command', <inner>) -PassThru` and prints the PID.
  - `<inner>` = `& 'C:\…\claude.exe' '/login'`: every element is a PS single-quoted literal (`'` doubled), so registry values can never break out. The launcher is not hidden (`-WindowStyle Normal`).
  - Response `{ ok, pid, command: "claude /login" }`. Writes one line to `data/health/audit.jsonl` (`ts, action: "login_open", agent`).
- `GET login_poll?pid=<n>` → `{ ok, running: bool }` (uses `isProcessRunning`). When it is no longer running, the health cache entries of that platform are invalidated.
- Retry = the inbox `retry` action (§3.3) for the job, or `health_check refresh=1` for a readiness row.

### 2.3 UI
- Job header (`MAW.addJobAction`): when the current job's flag is `needs_login`, show the buttons **"Đăng nhập lại"** (→ `login_open`) and **"Thử lại"** (→ `inbox_act retry`).
- A login card (modal-less, inside the Health tab and inside the inbox entry): "A terminal window opened — sign in there, then close it". It polls `login_poll` every 3 s. When the window closes: re-probe the agent, show ✓ / ✗, and highlight "Thử lại".
- Credentials are per platform, so the card says "applies to every agent on <platform>".

---

## 3. N5 — `inbox` feature (attention inbox)

### 3.1 Data — `data/inbox/items.json`
- `{ version: 1, items: [Item…] }`, newest first, capped at 500 (dismissed / done are pruned first).
```jsonc
{ "id": "i3k9x2a",                       // ^i[0-9a-z]{6}$ — short so it can be typed on a phone
  "kind": "needs_login" | "needs_input" | "failed" | "blocked" | "rate_limited" | "review_changes" | "budget_block" | "approval" | "handoff_done" | "custom",
  "severity": "info" | "warn" | "error",
  "title": "codex: login expired", "detail": "…≤ 2000 chars, secrets redacted…",
  "agent": "codex", "role": "reviewer", "job_id": "job_…", "project": "C:\\laragon\\www\\x",
  "source": "jobs" | "health" | "telegram" | "api" | "s4" | "s6" | "<feature>",
  "ref": { },                            // free JSON from the producer (≤ 4 KB), e.g. S4 { budget_id }, S6 { handoff_id }
  "actions": ["open","retry","login","approve","reject","reply","dismiss"],
  "retry": { "mode": "task", "agent": "codex", "role": "reviewer", "project_path": "…", "prompt": "…", "model": "", "effort": "", "team": {}, "reviewers": [], "implementer": "" },
  "status": "open" | "dismissed" | "done" | "approved" | "rejected",
  "resolution": { "action": "approve", "text": "…", "by": "ui" | "telegram", "at": "…" } | null,
  "dedupe_key": "job:job_…:needs_login",
  "created_at": "…", "updated_at": "…" }
```
- `retry` is captured when the item is created (job files are cleaned after 2 h). The prompt comes from `<job>.prompt.txt` (BOM stripped, ≤ 20000 chars).
- `dedupe_key` unique among non-dismissed items: adding again only updates `updated_at` / `detail`.

### 3.2 Producers
1. **Job scanner** (inside the inbox feature). It runs from `status()` and from a background tick (every 10 s, `unref`'d, started lazily on the first `status()` / route call — see Requests to Tech Lead #1). For each `job_*.json` in `paths.jobsDir` (all of them, not only the 8 in `readJobs`), memoized by `job_id + log size`:
   - `FAILED` + `classifyLog = needs_login` ⇒ `needs_login` (error, actions `login, retry, open, dismiss`);
   - `FAILED` + log contains `HOOK_BLOCKED (before-agent)` ⇒ `blocked` (warn; the detail is the hook reason; actions `retry, open, dismiss`);
   - `FAILED` + `rate_limited` ⇒ `rate_limited` (warn);
   - other `FAILED` (exit ≠ 0, not `CANCELLED`) ⇒ `failed` (error, actions `retry, open, dismiss`);
   - `auto-gate` jobs that end without "APPROVED by all reviewers", and `council` jobs with exit 2 ⇒ `review_changes` (warn, actions `open, retry, dismiss`; the detail is the last `Round … Result` line or `COUNCIL_RESULT` line);
   - `RUNNING` jobs whose log has not grown for ≥ 90 s and whose last non-empty line matches `/(\?|\(y\/n\)|\[y\/N\]|\[Y\/n\]|press enter|waiting for (your )?input|continue\?)\s*$/i` ⇒ `needs_input` (warn, actions `open, reply, dismiss`). It is resolved automatically when the job ends.
   - A job that becomes `DONE` after a retry auto-resolves the older item (`status: done`).
2. **Other streams** (S4 budget blocks / approvals, S6 `handoff-done`, hooks): `POST inbox_add`, or in-process `import { addInboxItem, onInboxResolved } from '../inbox/store.ts'`.

### 3.3 Actions
- `GET inbox_list?status=open|all&kind=&source=&limit=50` → `{ ok, items, counts: { open, by_kind: {…} } }`.
- `GET inbox_get?id=` → `{ ok, item }` (404 when unknown). Producers use it to read resolutions.
- `POST inbox_add { kind, title, severity?, detail?, agent?, role?, job_id?, project?, source?, ref?, actions?, dedupe_key? }` → `{ ok, item, created: bool }`. Validation: `kind` in the list, `title` 1–200 chars, `detail` ≤ 2000, `ref` ≤ 4 KB, `actions` ⊂ the list.
- `POST inbox_act { id, action, text? }`, where `action ∈ dismiss | done | retry | approve | reject | reply`:
  - `dismiss` / `done` / `approve` / `reject`: set `status` + `resolution`; fire `onInboxResolved(item)`.
  - `retry`: requires `item.retry`. Calls `ctx.startJob(item.retry)` and returns `{ ok, item, job_id }`. The item becomes `done` with `resolution.job_id`. Audit line.
  - `reply`: `text` 1–4000 chars. Stores the resolution and fires `onInboxResolved`. If no other feature handles it (no listener returned `true`) and the item has `retry`, it starts a **follow-up job** with the same agent / role / project and prompt = `<original prompt>\n\n## Follow-up from the user\n<text>` (S5 steer can take this over later via the listener).
  - Unknown id ⇒ 404; action not in `item.actions` (except `dismiss`) ⇒ 400.
  - Every action appends to `data/inbox/audit.jsonl` (`ts, id, action, by`; never the text).
- `POST inbox_clear { status: "dismissed"|"done" }` (destructive, the UI confirms) → removes those items.
- `status` contribution `feature_data.inbox = { open, by_severity: {error, warn, info}, latest: [5 newest open items, without retry.prompt], job_flags: { job_id: flag } }`.

### 3.4 UI (`feat-inbox.js`)
- **Header badge** (`MAW.addHeaderItem`): bell + count of open items (red when any `error`). Click → a drawer listing the open items. Each row: kind icon, title, agent chip, relative time and quick buttons per `actions` (open = select the job in the live log via `MAW.state` / job id; retry; login; approve / reject; reply opens an inline textbox; dismiss).
- Tab "Hộp thư / Inbox": a fuller list with filters (open / all, kind) and "Clear dismissed" (confirm).
- **Toasts**: one toast per *new* item id (seen ids kept in `sessionStorage`). This gives one consistent attention channel; the built-in job toasts stay until the Tech Lead removes them (Request #3).
- Telegram settings (two-way enable, digest times, test) also live in this tab (§4.4).

---

## 4. N5 — `telegram` feature (two-way)

### 4.1 Config & state
- The token and `chat_id` stay in the existing notify config (`loadInternalNotifyConfig(paths.notifyCfgFile)` from `server/actions/notify.ts`). S3 never stores or returns the token.
- `data/telegram/config.json` `{ inbound: false, push_inbox: true, digest: { enabled: false, morning: "08:30", evening: "18:00" } }` — **opt-in**: nothing polls until `inbound: true`.
- `data/telegram/state.json` `{ offset, last_digest: { morning: "2026-10-25", evening: "…" }, msg_map: { "<telegram message_id>": "<inbox id or job id>" } }` (`msg_map` capped at 500).
- **Single poller**: `data/telegram/poller.lock` `{ pid, port?, heartbeat }`. A server polls only when the lock is free, or its heartbeat is > 60 s old, or its pid is dead. The heartbeat is refreshed every 20 s. This stops a worktree test server and the main server from fighting over `getUpdates` (Telegram returns 409).

### 4.2 Poll loop
- Global `fetch` (Node built-in): `getUpdates?timeout=25&offset=<n>&allowed_updates=["message","callback_query"]`, `AbortSignal.timeout(35000)`.
- Backoff on errors: 5 s → 60 s. A 401 stops the loop with `last_error: "bot token rejected"`. A 409 backs off for 60 s.
- Every error string passes `redact()`, which removes the token and `bot<digits>:<...>`.
- Only `message.chat.id` / `callback_query.message.chat.id` equal to `telegram_chat_id` are handled. Everything else is dropped silently (only a counter `ignored` is kept).
- Commands (case-insensitive, `@botname` suffix allowed):
  - `/status` — running jobs (id, agent, role, project, elapsed), open inbox count by severity, health summary.
  - `/inbox` — the 10 newest open items: `i3k9x2a ⚠ codex: login expired`.
  - `/approve <id>`, `/reject <id>`, `/retry <id>` — through the same code as `inbox_act` (`by: "telegram"`).
  - `/stop <job_id|inbox id>` — `handleCancelJob` from `server/actions/jobs.ts`.
  - `/task <text>` — S2 `task_create` over HTTP to the own server (`POST http://<host>/api?action=task_create` with `X-MAW-Request: 1`, body `{ title: <first 80 chars>, prompt: <text>, project_path: <last selected / none> }`). `<host>` is the validated `Host` header captured from the first request any S3 route saw (Request #1 asks for `ctx.serverUrl`). If S2 is absent (400 unknown action) ⇒ reply "Task board (S2) is not available".
  - `/help`.
  - A **reply** to a bot message ⇒ looks up `reply_to_message.message_id` in `msg_map`, or a `job_…` id in the replied text (the runner's own notifications) ⇒ `inbox_act reply` on that item (for a job id: the newest open item of that job, else a new `custom` item then reply).
- Inline buttons: pushed items carry `inline_keyboard` with the item's actions (`a:<action>:<id>`, ≤ 64 bytes). `callback_query` ⇒ the same action + `answerCallbackQuery`.
- **Push**: when `push_inbox` is on, every new inbox item with severity `warn` / `error` (kinds other than plain `failed`, which `send-notification.ps1` already sends) is sent once with buttons, and its `message_id` is recorded in `msg_map`.
- **Digest** (optional): at `morning` / `evening` local time (checked every minute, once per day each) — jobs of the last 12 h (done / failed), open inbox, cost from the audit for the same window, health summary.

### 4.3 Actions
- `GET telegram_status` → `{ ok, configured: bool (token + chat id set), inbound, polling: bool, owner: "this" | "other" | null, last_update_at, last_error, ignored, digest, push_inbox }`.
- `POST telegram_config { inbound?, push_inbox?, digest? }` (validation: `HH:MM`) → status. Turning `inbound` on starts the loop; turning it off stops it and frees the lock.
- `POST telegram_test` → sends "MAW two-way bot is connected ✓ — /help" and returns `{ ok, sent }`.

### 4.4 UI (inside the Inbox tab, section "Telegram 2 chiều")
Shows the state (configured / polling / owner / last error), the toggles inbound / push / digest + two time inputs, a test button, and the command cheat-sheet. If the token / chat id are not set: a link to the existing Notifications tab.

---

## 5. N8 — `timeline` feature (Gantt + report)

### 5.1 Data
- `data/timeline/events.jsonl` — one JSON line per event: `{ ts, event: "job-start"|"job-finish"|"handoff"|"custom", job_id?, mode, agent, role, project, exit_code?, status?, title?, start?, end?, cost_usd?, ref? }`.
- Producers:
  - hooks `scripts/hooks/job-start/30-timeline.ps1` and `job-finish/30-timeline.ps1`: append a line to `$MAW_HOME/data/timeline/events.jsonl` (UTF-8, no BOM; they never throw);
  - the server-side snapshot of job metas in `jobsDir` on each query (covers jobs from before the hooks existed and jobs whose hook failed);
  - `POST timeline_add` for S6 handoffs.
- Rotation: when the file is > 5 MB, keep the newest 20000 lines.

### 5.2 Actions
- `GET timeline?from=<iso>&to=<iso>&project=<path>&job_id=<id>`:
  - default window: the last 24 h; max window 31 days; `job_id` = the window of that team run;
  - response `{ ok, from, to, lanes: [{ agent, label, color, items: [{ id, kind: "job"|"handoff", title, mode, role, project_name, start, end, status: "RUNNING"|"DONE"|"FAILED"|"CANCELLED", exit_code, cost_usd, tokens: { in, out }, score, verdict }] }], totals: { jobs, done, failed, cost_usd, busy_ms } }`;
  - job start / end from events + metas (`end = null` while running);
  - `cost_usd` / tokens / score / verdict: the audit rows (`paths.auditFile`) whose `WorkDir` equals the job project and whose `Timestamp` lies within [start, end + 5 s] (cost uses `estimateEntryTelemetry` from `server/lib/audit.ts`). For team / council / auto-gate jobs, audit rows of each tool become **sub-items on that tool's lane** (kind `"job"`, title `"<role> (in <job_id>)"`, start = previous row end or job start, end = row timestamp).
- `POST timeline_add { kind: "handoff"|"custom", agent, title, start, end?, status?, cost_usd?, project?, ref? }` → `{ ok }`.
- `GET timeline_report?format=md|html&from&to&project&job_id` → `{ ok, filename: "maw-report-20261025-1000.md", mime, content }`. Content:
  - summary (window, jobs, done / failed, total time, total cost);
  - per-agent table (jobs, ok, failed, busy time, cost, avg score);
  - per-job list;
  - review scores (audit reviewer rows: tool, score, verdict, time);
  - files changed: `git log --since=<from> --until=<to> --name-only --pretty=format:` in the project (argument array, ≤ 300 files, unique), only when `project` is given and is a git repo.
  - The HTML is self-contained (inline CSS, escaped, no scripts).

### 5.3 UI (`feat-timeline.js`) — tab "Dòng thời gian / Timeline"
- Window presets (1 h / 6 h / 24 h / 7 d / this job), project filter (current project / all).
- A Gantt drawn with absolutely positioned divs: one lane per agent (registry colour), a time axis with ticks, and bars coloured by status (running = striped / animated, done = ok, failed = err, cancelled = faint).
- Tooltip: title, role, duration, cost, score.
- Click on a bar → open that job's log (`MAW` job selection) when it still exists.
- "Xuất Markdown" / "Xuất HTML" → `timeline_report` → download via `Blob` + `<a download>` (allowed by the CSP: blob URL, same document).

---

## 6. N12 — Doctor in the UI (part of `health`)

- `GET doctor_report?updates=1` → `{ ok, platforms: [...], environment, scripts, hooks, notify }`:
  - `platforms: [{ id, label, installed, version, login, status, reason, latest?: string|null, update_available?: bool, install_cmd, update_cmd, login_cmd }]` (from the health probes).
  - `latest` only with `updates=1`: `npm view <pkg> version` (argument array, 8 s timeout, cached 6 h in `data/health/latest.json`) for npm-installed CLIs (`codex → @openai/codex`, `gemini → @google/gemini-cli`). Others ⇒ `null`.
  - Install / update commands are **display-only strings** (copy buttons; never executed):

    | agent | install_cmd | update_cmd |
    | :--- | :--- | :--- |
    | codex | `npm i -g @openai/codex` | same |
    | gemini | `npm i -g @google/gemini-cli` | same |
    | claude | `irm https://claude.ai/install.ps1 \| iex` | `claude update` |
    | cursor | `irm 'https://cursor.com/install?win32=true' \| iex` | `cursor-agent update` |
    | aider | `python -m pip install aider-install; aider-install` | `aider --upgrade` |
    | antigravity | "Install the Antigravity IDE" | — |
  - `environment`: node `process.version`, git / gh / powershell versions (`--version`, 3 s each), `MAW_HOME`, projects root.
  - `scripts`: `paths.scriptsDir`, the required scripts present / missing (the `doctor.ps1` list), `agents.json` present, `registry_warnings`.
  - `hooks`: for each event dir under `<scriptsDir>/hooks`: the `.ps1` file names.
  - `notify`: `{ desktop_toast, webhook: bool, telegram: bool }` (booleans only).
- UI: a "Doctor" section in the Health tab:
  - one row per platform: install / login / version / "update available" chip, with buttons "Mở terminal đăng nhập" (→ `login_open`), "Sao chép lệnh cài" and "Sao chép lệnh cập nhật" (`navigator.clipboard`);
  - an environment table, a scripts checklist and a hooks list;
  - "Check for updates" (the slower call with `updates=1`).

---

## 7. N14 — `mcp` feature + dashboard MCP server

### 7.1 Config manager
Platforms and files:
- `claude`: `~/.claude.json` → `mcpServers` (user scope). The file is large and also written by Claude Code, so only that key is replaced and every other key is preserved byte-for-byte where possible (parse → set → `JSON.stringify(obj, null, 2)`). The UI warns to close Claude Code sessions first.
- `codex`: `~/.codex/config.toml` → `[mcp_servers.<name>]` + `[mcp_servers.<name>.env]` tables.
  - A minimal TOML reader for exactly these tables: string / literal string, number, bool, array of strings, inline table of strings.
  - Writing replaces only the managed tables' text blocks (from the header to the next header that is not their sub-table) and appends new ones at the end. Everything else stays verbatim.
  - Unknown keys inside a managed table (`startup_timeout_sec`, `env_vars`, …) are preserved.
- `gemini`: `~/.gemini/settings.json` → `mcpServers` (the file is created when missing).

Normalized server shape (UI ⇄ server):
```jsonc
{ "name": "maw",                           // ^[A-Za-z0-9_.-]{1,64}$
  "transport": "stdio" | "http",
  "command": "node", "args": ["C:\\…\\server\\mcp\\main.ts"],   // stdio
  "url": "http://127.0.0.1:4317/mcp",         // http (claude: type "http"; gemini: httpUrl; codex: url)
  "env": { "API_KEY": "••••a1" },             // values masked in every response
  "extra": { "startup_timeout_sec": 120 } }   // platform-specific keys, preserved
```
- Env values are **masked** (`••••` + last 2 chars, or `••••` when ≤ 6 chars) in `mcp_config`, `mcp_preview` diffs and audit lines. On write, a value equal to its masked form means "keep the existing value".

Actions:
- `GET mcp_config` → `{ ok, platforms: [{ platform, file, exists, writable, servers: [Server…], error? }], dashboard_server: { command: "node", args: [<abs path>/server/mcp/main.ts], env: { MAW_URL: "http://127.0.0.1:<port>" } } }`.
- `POST mcp_preview { platform, set?: [Server…], remove?: [name…] }` → `{ ok, diff, changed: bool }`. `diff` is a unified line diff (in-house LCS, masked).
- `POST mcp_apply { platforms: [..], set?, remove?, confirm: true }`:
  - without `confirm: true` ⇒ 400;
  - for each platform: backup the original file to `data/mcp/backups/<platform>-<yyyymmdd-HHMMss>.<ext>` (keep the newest 20 per platform), write atomically, append to `data/mcp/audit.jsonl`;
  - response `{ ok, results: [{ platform, changed, backup, error? }] }`. One failing platform does not stop the others.
- `GET mcp_backups` → the list. `POST mcp_restore { platform, backup, confirm: true }` → restores (after backing up the current file).
- "Apply to all agents" = `mcp_apply` with every platform whose file exists (or `gemini`, which may be created).

### 7.2 Dashboard as an MCP server — `server/mcp/main.ts`
- Run: `node server/mcp/main.ts [--url http://127.0.0.1:4317]` (env `MAW_URL` also works). stdio, newline-delimited JSON-RPC 2.0, zero dependencies. Logs go to **stderr** only.
- Methods: `initialize` (echo the client's `protocolVersion` if it is one of `2025-06-18`, `2025-03-26` or `2024-11-05`, else `2025-06-18`; `capabilities: { tools: {} }`; `serverInfo: { name: "maw-dashboard", version }`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Unknown method ⇒ `-32601`; bad JSON ⇒ `-32700`.
- Tools (JSON Schemas in `tools/list`). Each one calls the HTTP API (`X-MAW-Request: 1`, `Content-Type: application/json`) and returns `content: [{ type: "text", text: <compact JSON / summary> }]`, or `isError: true` with the API error:

  | tool | input | API call |
  | :--- | :--- | :--- |
  | `list_agents` | `{}` | `GET status` → `agents` (id, label, installed, version, models) + `feature_data.health` |
  | `create_task` | `{ title, prompt?, project_path?, agent?, role? }` | `POST task_create` (S2). If missing ⇒ isError "task board not available" |
  | `start_job` | `{ project_path, prompt, agent?, role?, mode? ("task"), model?, effort? }` | `POST run_job` |
  | `job_status` | `{ job_id, tail_bytes? (≤ 16000, default 4000) }` | `GET job_status` → status, exit_code + the last `tail_bytes` of the log |
  | `request_review` | `{ project_path, reviewers?: [ids] }` | `POST run_job { mode: "council", reviewers, project_path, prompt: "Review the current changes" }` |
  | `inbox` | `{ status?: "open"\|"all", limit? }` | `GET inbox_list` |
- Registration docs: `server/mcp/README.md` covers Claude (`claude mcp add maw -- node <abs>\server\mcp\main.ts`), Codex (`[mcp_servers.maw] command = "node"`, `args = [...]`), Gemini (`mcpServers.maw`) and the one-click "Đăng ký MCP của dashboard" button in the MCP tab (which uses `mcp_apply` with `dashboard_server`).

### 7.3 UI (`feat-mcp.js`) — tab "MCP"
- Platform columns (Claude / Codex / Gemini) listing the servers, with the transport, command / url and env keys.
- Editor form (name, transport, command, args one per line, url, env `KEY=value` lines) → "Xem diff" shows the per-platform diff → "Áp dụng" (confirm dialog) → results with backup names.
- Per-server actions: "Áp dụng cho mọi agent" (copies it to all platforms) and "Xoá" (confirm).
- "Đăng ký MCP của dashboard" button. Backups list with "Khôi phục" (confirm).

---

## 8. Tests (Antigravity)
- `server/features/<name>/*.test.ts`, run by `npm test` (the Request #2 glob, or a wrapper `server/tests/s3.test.ts` importing them). They use temp `MAW_HOME`, temp jobs dir and fake CLIs. **No real Telegram or real home configs:** the Telegram client takes an injectable `fetch` + base URL, and the MCP config paths are injectable.
- Coverage:
  - health: probe parsing (claude JSON, codex text, gemini config variants, `status_cmd` generic), redaction, 60 s cache, `team_rows`;
  - patterns: `classifyLog` table tests;
  - inbox: the scanner on fake job dirs (failed / auth / blocked / council exit 2 / needs_input), dedupe, `inbox_add` validation, `inbox_act` retry (calls `ctx.startJob` with the captured body), reply follow-up;
  - telegram: chat-id filtering, commands, `msg_map` reply, callback, token redaction, the lock;
  - timeline: event merge + audit cost join + report md / html escaping;
  - mcp: the TOML round-trip preserving unrelated text, JSON merge, masking, diff, backup + restore, the `confirm` guard;
  - MCP server: spawn `node server/mcp/main.ts --url <fake http server>` → initialize, tools/list, tools/call.
- Pester `tests/S3Hooks.Tests.ps1`: `30-health.ps1` blocks with a cached `error`, passes `warn` / no cache / `MAW_SKIP_HEALTH`; timeline hooks append valid JSON.
- api-smoke: no changes to the shared script (Request #4).

---

## Requests to Tech Lead
1. **Feature start-up hook + server URL in `ctx`**:
   - add an optional `init?(ctx)` to `MawFeature`, called once after `listen()`;
   - add `ctx.serverUrl` (`http://127.0.0.1:<port>`).
   - The Telegram poller and the inbox scanner then start without waiting for the first dashboard request, and `/task` needs no Host capture. Until then both start lazily on the first S3 route / `status()` call.
2. **Test glob**: let `npm test` also run `server/features/**/*.test.ts` (and `server/mcp/**/*.test.ts`). Until then S3 adds `server/tests/s3.test.ts`… which is outside S3 ownership. **Interim decision:** the S3 tests live in `server/features/<name>/<name>.test.ts`, and the stream lead runs them with `node --test server/features server/mcp`; please add the glob at merge.
3. **Toasts → inbox**: when the inbox is present, the built-in job-end toasts in `index.html` can be dropped (the inbox shows one toast per new attention item). Also emit a `job-flag` event, or show `feature_data.inbox.job_flags[job]` as a badge on the job row.
4. **api-smoke**: add a block for S3: `health_check` (200, an `agents` array), `inbox_add` → `inbox_list` → `inbox_act dismiss`, `timeline` (200), `mcp_config` against a temp `USERPROFILE` (no writes), and the 400 for `mcp_apply` without `confirm`.
5. **Registry**: add `"login_cmd": ["cursor-agent","login"]` and `"status_cmd": ["cursor-agent","status"]` to `cursor` (built-in defaults are used meanwhile). Consider switching `claude.login_cmd` to `["claude","auth","login"]` (non-REPL, exists in 2.1.308).
6. **`readJobs` limit**: `ctx.readJobs` returns only the 8 newest jobs, so S3 reads `paths.jobsDir` itself (read-only). An optional `ctx.readJobs({ limit })` would avoid that.
