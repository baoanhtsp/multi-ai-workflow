# S7 — Accounts, quota tracking, proactive routing and limit handoff

Status: approved by the Tech Lead, 2026-10-25. Owner: **Antigravity** (server, scripts, tests), **Claude** (dashboard UI, this spec).
Inspired by AIObox (aiobox.app), adapted from web chat accounts to the CLI agents this project runs. Out of scope: browser profiles, copying cookies or credentials, UI macros on provider sites, pooling or stretching any provider's quota.

## 0. Goals
1. **Several accounts per AI** (e.g. Claude *Work* and Claude *Personal*), each signed in separately on this machine.
2. **See every account's quota** (5-hour and 7-day windows where the provider has them) before a job starts, not after it fails.
3. **Route new work to an account or agent that has room** before the limit is hit (default threshold 85 %).
4. **When a chat hits its limit, hand it to an account or agent with room**, carrying a handoff letter (summary or last messages), so the conversation goes on.

Every decision is visible (job meta, timeline, chat) and the user can choose *suggest* (ask first) instead of *auto*.

## 1. Accounts

### 1.1 File `~/.maw/accounts.json` (per user, never in the repo)
```jsonc
{
  "version": 1,
  "accounts": [{
    "agent": "claude",                 // a registry agent id
    "id": "work",                      // ^[a-z0-9][a-z0-9-]{0,23}$, unique per agent; "default" is reserved (§1.2)
    "label": "Work",                   // 1–40 chars
    "enabled": true,
    "priority": 0,                     // lower is tried first when quotas tie
    "dir": "C:\\Users\\Admin\\.maw\\accounts\\claude\\work",   // config home of this account (§1.3); created empty
    "limits": {                        // optional plan caps used only for estimates (§2.2 d)
      "5h": { "tokens": 0 }, "7d": { "tokens": 0 }
    },
    "created_at": "ISO", "updated_at": "ISO"
  }]
}
```
- Holds **paths only**. No token, cookie or password is ever stored or copied by MAW.
- Writes are atomic (tmp + rename with the EPERM/EBUSY retry already used elsewhere) and audited through `appendActionAudit` (`feature: 'accounts'`).

### 1.2 The implicit `default` account
Every installed agent has an account `default` that is not in the file: it runs the CLI with the environment untouched (today's behaviour, the user's normal sign-in). It can be relabelled and given limits by adding an entry with `id: "default"` and no `dir`.

### 1.3 How an account is selected for a run — per adapter
An account is applied by **setting environment variables for the CLI process only**:

| Adapter | Variable | Notes |
| :--- | :--- | :--- |
| `claude` | `CLAUDE_CONFIG_DIR=<dir>` | Verify on the installed CLI (2.1.x) that login state, settings and sessions follow it. |
| `codex` | `CODEX_HOME=<dir>` | Sessions / rollout files then live under `<dir>\sessions`. |
| `gemini` (cli) | to verify | Find the supported variable (or `HOME`/`USERPROFILE` override) for its auth store. If none is reliable, Gemini supports `default` only and the UI says so. |
| `antigravity` | none | One IDE sign-in; `default` only. |
| other `cli` agents | registry `cli.account_env` | New optional registry field: `{ "<VAR>": "{account_dir}" }`; absent ⇒ `default` only. |

- **Antigravity must verify each row against the installed CLI's help / docs before coding, and write the result under "Verified" at the end of this file** (variable, what follows it, version checked).
- Env keys are taken from this table / `cli.account_env` only (no user-supplied keys). `dir` must be an absolute existing directory; MAW creates it under `~/.maw/accounts/<agent>/<id>` when the user does not pick one.

### 1.4 Sign-in per account
- `POST account_login { agent, account }` opens a visible terminal running the agent's `login_cmd` with the account's environment (same launcher as S3 `login_open`). `GET account_status?agent=&account=` runs `status_cmd` with that environment and returns `{ login: 'ok'|'logged_out'|'unknown', detail }`.
- Never copy `.credentials.json`, `auth.json` or similar between accounts.

### 1.5 Runs carry an account
- `run_job`, `chat_send`, `handoff_dispatch`, `task_start`, council runs and `ctx.startJob` accept an optional `account` (id of an account of the chosen agent). Omitted ⇒ the router picks one (§3).
- `invoke-agent.ps1 -Account <id>` and `invoke-cli-agent.ps1 -Account <id>`: resolve the account from `accounts.json`, set the env of §1.3 for the child CLI only, and fail with a clear message when the account is unknown, disabled or its dir is missing.
- Job meta: `account`, plus `routing` (§3.4). Audit rows (`Write-MawAuditEntry`, `dispatch.ts`) get an `Account` field; rows without it count as `default`.
- Workspace agents (S6) get an optional `account` field (`""` = let the router choose).

## 2. Quota tracking

### 2.1 Snapshot per account
```jsonc
{
  "agent": "codex", "account": "default",
  "windows": [
    { "id": "5h", "used_percent": 42.0, "resets_at": "ISO|null", "source": "provider", "window_minutes": 300 },
    { "id": "7d", "used_percent": 18.5, "resets_at": "ISO|null", "source": "provider", "window_minutes": 10080 }
  ],
  "level": "ok",                       // ok < warn (≥ 70) < high (≥ switch_at, default 85) < full (≥ 100 or cooling down)
  "cooldown_until": null,              // from a limit error (§2.2 c)
  "login": "ok",                       // last known, from §1.4 / S3 health
  "checked_at": "ISO", "error": null
}
```
`level` uses the **highest** window. Stored in `~/.maw/data/quota/snapshots.json`; every change of level appends to `~/.maw/data/quota/events.jsonl`.

### 2.2 Sources, in order of trust
a. **Provider-reported**
   - Codex: the newest `token_count` events with `rate_limits` in `<CODEX_HOME>\sessions\**\rollout-*.jsonl`. Read **both** `primary` and `secondary` (today `health/probes.ts` keeps only one), mapping `window_minutes` 300 → `5h`, 10080 → `7d`, anything else → `custom`.
   - Claude: find what the installed CLI exposes without spending a model call (e.g. rate-limit fields in `--output-format stream-json` events of normal runs, a usage command, response headers recorded in the session log). Record it under "Verified". If nothing reliable exists, Claude uses c + d only.
   - Others: none unless verified.
b. **Captured during runs**: when a job of that account emits rate-limit data in its own output, update the snapshot right after the job (no extra call).
c. **Errors**: a run classified `rate_limited` (S3 `classifyLog`) sets `cooldown_until` (the reset time in the message when present, else now + 1 h) and `level: full`. This replaces S4's per-agent cooldowns with per-account ones; S4 reads them through `ctx.callAction('quota_get')`.
d. **Estimates**: when the account has `limits`, tokens of its audit rows inside the window / cap → `used_percent` with `source: "estimate"`.

Rules: never start a model run to measure quota; no network call other than what the CLIs already do; reads must be cheap (bounded tail reads like `probes.ts`).

### 2.3 When it refreshes
- Feature `start`: every 5 minutes for enabled accounts (skipped in tests), plus right after each finished job of that account, plus `POST quota_refresh { agent?, account? }`.
- Before any routing decision (§3) and before a limit handoff (§4) the snapshot is re-read if older than 60 s.

## 3. Proactive routing

### 3.1 Config (in the S4 fallback config, `fallback_get` / `fallback_save`)
```jsonc
"quota_routing": {
  "enabled": true,
  "mode": "auto",                // "auto" = switch without asking | "suggest" = run as asked, warn and offer the switch | "off"
  "switch_at": 85,               // percent, 50–99
  "prefer": "same-agent",        // "same-agent" (other accounts first) | "any" (best account across the role's fallbacks)
  "when_all_full": "wait"        // "wait" = queue in S4 recovery until the earliest reset | "run" = run on the least used anyway
}
```

### 3.2 Choosing where a run goes (agent A, role R, optional requested account)
1. Requested account of A, if enabled, signed in and below `switch_at` ⇒ use it.
2. Else other enabled, signed-in accounts of A below `switch_at`, lowest `level` / `used_percent`, then `priority`.
3. Else (or first, when `prefer: "any"`) the role's fallback agents (S4 `roles[R].fallbacks`) with their best account below `switch_at`.
4. Else `when_all_full`.
- `mode: "suggest"` ⇒ steps 2–4 are only proposed: the run uses the requested account, the job meta / response carry `routing.suggestion`, and the UI offers "Chuyển".
- A requested account that is `full` is never used in `auto` mode.

### 3.3 Where it happens
In the Node server before the job is spawned (`launchJob` / `ctx.startJob`), so every source (dispatch, chat, board, schedules, handoffs, council) gets it. The PowerShell `before-agent` S4 hook keeps working for direct CLI use and may return `@{ Switch = '<agent>'; Account = '<id>' }`.

### 3.4 Record
Job meta `routing: { requested: { agent, account }, chosen: { agent, account }, mode, reason: 'ok'|'switched'|'suggested'|'waiting'|'all-full', quota: { <window>: used_percent } }`. A switch adds a timeline event and, in suggest mode, nothing else; `when_all_full: wait` adds an inbox item with the reset time.

## 4. Limit handoff for chats (S6) and board jobs

### 4.1 Triggers
- After a chat turn, the account's `level` is `high` or `full`, or
- the turn failed as `rate_limited`.

### 4.2 Action
1. Re-read the quota (§2.3). If the trigger no longer holds, stop.
2. Choose the target with §3.2 (same agent other account first, then fallbacks for the agent's `role`).
3. `mode: "auto"`: switch the conversation to the target (`platform` / `account`), `session++`, and add a system message, e.g. *"Hết hạn mức Claude · Work (5h 96 %, mở lại sau 2 giờ 10 phút) → chuyển sang Claude · Personal (12 %), kèm thư bàn giao."* If the turn failed, re-send the same user message on the target.
   `mode: "suggest"`: add a system message with the same text and actions **Chuyển ngay** / **Chờ tới lúc mở lại**; `POST chat_limit_handoff { conversation_id, to_agent?, to_account? }` performs the switch.
4. **Handoff letter**: the compaction summary when present, else the last 10 messages (each ≤ 2500 chars), prefixed with `# Handoff letter` and the reason; then the agent's normal brief (S6 §3.1), including `# Language`.
5. Record on the conversation `limit_handoffs: [{ at, from: { agent, account }, to: { agent, account }, reason, quota }]`.
6. The system message is `{ role: 'system', kind: 'limit_handoff', text, handoff: { from, to, reason, quota, resets_at, state: 'done'|'pending'|'declined' } }` so the UI can draw it (and, while `pending`, its two actions). `POST chat_limit_handoff { conversation_id, decline: true }` marks it `declined`.
- Board / scheduled jobs that fail `rate_limited`: S4 recovery first tries §3.2 for a new account / agent, then waits as today.

## 5. API summary
| Action | Method | Body / query | Returns |
| :--- | :--- | :--- | :--- |
| `account_list` | GET | – | `{ ok, accounts: [{ agent, id, label, enabled, priority, dir, limits, supported, login, is_default }], adapters: { <agent>: { supported: bool, env_var } } }` |
| `account_save` | POST | `{ account }` | `{ ok, account }` (creates the dir when missing; 400 on unsupported adapter / bad id) |
| `account_delete` | POST | `{ agent, id }` | `{ ok }` (the dir is kept; `default` cannot be deleted) |
| `account_login` | POST | `{ agent, account }` | `{ ok, login_id }` |
| `account_status` | GET | `?agent=&account=` | `{ ok, login, detail }` |
| `quota_get` | GET | `?agent=&account=` (optional) | `{ ok, snapshots: Snapshot[], routing: quota_routing }` |
| `quota_refresh` | POST | `{ agent?, account? }` | `{ ok, snapshots }` |
| `quota_route_preview` | GET | `?agent=&role=&account=` | `{ ok, decision: routing }` (what §3.2 would do now; used by the UI before running) |
| `chat_limit_handoff` | POST | `{ conversation_id, to_agent?, to_account? }` | `{ ok, conversation }` |

`status.feature_data.quota = { accounts: n, worst: { agent, account, level, used_percent, window, resets_at } | null, by_agent: { <agent>: { level, used_percent } } }` (cheap, from the snapshots file).

## 6. UI (Claude)
Files: `dashboard/feat-quota.{js,css}` (declared as the `ui` of the server feature `quota`), plus small changes in `index.html` (dispatch account picker) and `feat-workspace.js` (agent account, limit-handoff messages). The account list and routing settings are a companion panel of the Agents page (tab id `accounts`).

- Header: one quota pill (worst account, coloured by level, reset countdown); click opens the Agents page.
- Agents page: section **"Tài khoản & hạn mức"** — one row per account (agent · label), bars for 5h / 7d with reset countdowns and a source badge (*nhà cung cấp* / *ước lượng*), login state, actions *Đăng nhập*, *Kiểm tra*, *Sửa*, *Xoá*; **+ Thêm tài khoản** per supported agent with a short explanation of what the account dir is.
- Same section: `quota_routing` controls — mode, threshold slider, prefer, when all full (saved through `fallback_save`).
- Dispatch / workspace / board card: an account picker next to each agent (*Tự chọn* by default) and a one-line routing preview from `quota_route_preview` ("Sẽ chạy bằng Claude · Personal (12 %)").
- Workspace chat: limit-handoff system messages with their actions; the conversation header shows the current account.
- Help drawer and Get started texts updated.

## 7. Tests and Definition of Done
- Unit: account file validation; env per adapter; codex rollout parsing of both windows; estimate math; level thresholds; §3.2 decision table (auto / suggest / off, prefer, when_all_full); handoff letter assembly; limit handoff in both modes.
- Integration: `run_job` with `account` sets the env for the child (fake CLI printing its env), job meta `routing`, audit `Account`; a fake CLI that prints a rate-limit error triggers cooldown + switch.
- Isolation: tests use temp `MAW_HOME` / `USERPROFILE` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR`; the real `~/.claude`, `~/.codex`, `~/.gemini` and `~/.maw` must be byte-identical before / after (extend the hash table).
- typecheck, `npm test`, all Pester, `api-smoke` green with normal and 8.3 TEMP paths; `install.ps1` re-run.

## Verified (filled in by Antigravity)
_Per adapter: variable, what follows it (login, settings, sessions), CLI version checked, quota source found._

| Adapter | CLI Version Checked | Account Env Variable | What Follows It | Non-LLM Quota Source Found |
| :--- | :--- | :--- | :--- | :--- |
| `claude` | `2.1.308 (Claude Code)` | `CLAUDE_CONFIG_DIR=<dir>` | Isolates `configDirectory` (`<dir>`), login credentials (`<dir>\.credentials.json`, `<dir>\.claude.json`), `settings.json`, and session logs (`<dir>\projects\**\*.jsonl`). Running `claude auth status` with an empty `<dir>` exits `1` with `"loggedIn": false` without touching `~/.claude`. | Session JSONL files (`<dir>\projects\**\*.jsonl`) record per-message token usage (`message.usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and rate-limit errors in stdout/stderr (source `c`), plus rolling 5h/7d token estimates (source `d`) from audit/session logs against user-configured `limits`. |
| `codex` | `codex-cli 0.163.0` | `CODEX_HOME=<dir>` | Isolates login credentials (`<dir>\auth.json`), settings (`<dir>\config.toml`), and rollout session logs (`<dir>\sessions\**\rollout-*.jsonl`). Running `codex login status` with an empty `<dir>` exits `1` (`Not logged in`) without touching `~/.codex`. | `<CODEX_HOME>\sessions\**\rollout-*.jsonl` `token_count` events contain `payload.rate_limits.primary` (`window_minutes: 300` -> `5h`, or `10080` -> `7d` on ProLite) and `payload.rate_limits.secondary` (`window_minutes: 10080` -> `7d`), each with `{ used_percent, window_minutes, resets_at }` (source `a`, `provider`), plus error cooldowns (source `c`) and token estimates (source `d`). |
| `gemini` (cli) | `0.65.0` (`@google/gemini-cli`) | `GEMINI_CLI_HOME=<dir>` (via `cli.account_env: { "GEMINI_CLI_HOME": "{account_dir}" }` in `agents.json`) | Overrides internal `homedir()` in `@google/gemini-cli`, isolating `<dir>\.gemini\oauth_creds.json`, `google_accounts.json`, `settings.json`, and `<dir>\.gemini\tmp\**\chats\*.json`. | In-memory `QuotaContext` during interactive TUI only; non-LLM quota uses rate-limit error detection / cooldowns (source `c`) and rolling 5h/7d token estimates against account `limits` (source `d`). |
| `antigravity` | IDE bridge (`language_server`) | _None (`supported: false`)_ | Bound to the running IDE process; exposes only `default`. | Error cooldowns (source `c`) and token estimates (source `d`). |
| Other `cli` (`cursor`, `aider`) | Registry `adapter: "cli"` | `cli.account_env` in `agents.json` / `~/.maw/agents.json` | Supported when `cli.account_env` maps an env var to `"{account_dir}"`; otherwise exposes only `default` (`supported: false`). | Error cooldowns (source `c`) and token estimates (source `d`). |
