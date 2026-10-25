# Project Specification (`SPEC.md`): Multi-AI Mission Control Dashboard (v4.0)

> **v4.0 — any AI, not one vendor.** Every AI is an entry in the **Agent Registry** (§7). Claude, Codex and Antigravity become ordinary registry entries next to Gemini CLI, Cursor Agent CLI and Aider; the dashboard, roles, team mode, Council, Auto-Gate, SPEC Guard and statistics treat all agents the same way. Adding an AI = adding a registry entry, no code change.

## 1. Architecture & Tech Stack
- **Agent Registry (v4.0)**: `antigravity/skills/claude-leader/agents.json` (shipped default, installed next to the scripts) merged with the optional user file `~/.maw/agents.json` (§7).
- **Dashboard Server (v3.0 — replaces PHP)**: Node.js **24 LTS** (minimum **22.18**), TypeScript executed **natively** by Node (type stripping, no build step, no `dist/`).
  - **Zero runtime dependencies**: only `node:*` built-ins (`node:http`, `node:child_process`, `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:test`). Dev-only dependencies: `typescript`, `@types/node` (used for `tsc --noEmit` in CI). `package.json` has `"type": "module"`, `"engines": { "node": ">=22.18" }` and scripts `start`, `test`, `typecheck`.
  - TS rules (`tsconfig.json`: `"noEmit": true`, `"erasableSyntaxOnly": true`, `"verbatimModuleSyntax": true`, `"allowImportingTsExtensions": true`, `"strict": true`, `"module": "nodenext"`, `"target": "esnext"`): no `enum`, no `namespace`, no constructor parameter properties; `import type` for type-only imports; relative imports end in `.ts`.
  - Start: `node server/main.ts [--port 4317] [--projects-root <dir>]`, or `start-dashboard.ps1` (checks Node ≥ 22.18, starts the server hidden if the port is free, waits for `GET /api?action=status`, opens `http://127.0.0.1:<port>/`). `--stop` stops it.
  - Binds **`127.0.0.1` only** (default port `4317`). Serves `dashboard/index.html` at `/` and `/index.html`, files matching `dashboard/*.css|*.js|*.svg|*.png|*.ico` as static (no directory listing, no path traversal, `404` otherwise), and the API at **`/api?action=<action>`**.
  - **Every child process** is spawned with `spawn`/`execFile` and an **argument array** — `shell: false`, `windowsHide: true`. No string is ever passed to a shell.
  - Projects root: `--projects-root`, else env `MAW_PROJECTS_ROOT`, else the parent directory of the repository (same as v2.2).
  - **Storage stays where v2.2 put it** (notify config, version cache, job dir, audit files), so settings and history carry over from the PHP version. The scripts directory and project-path validation (`resolveProjectPath`) are resolved exactly as in v2.2.
- **PowerShell Orchestration Suite (`antigravity/skills/claude-leader/scripts/`)** — unchanged, must run on Windows PowerShell 5.1:
  - `invoke-claude.ps1`, `invoke-codex.ps1`, `invoke-antigravity.ps1`, `invoke-council-review.ps1`, `invoke-spec-guard.ps1`, `invoke-auto-gate.ps1`, `send-notification.ps1`, `lib/maw-common.ps1`, `invoke-agent.ps1` + `../templates/roles/*.md` (§5).
- **Frontend**: single-file bilingual (VI / EN) HTML5 + vanilla CSS/JS, no framework, no CDN scripts (`dashboard/index.html`) — **100% authored by Claude**. Uses `api` as the API base when served by the Node server.
- **Tests**: `node --test server/tests` (unit), Pester 5 (`tests/*.Tests.ps1`), `tests/api-smoke.ps1` (black-box API test that starts the Node server itself), all run in CI (`actions/setup-node` with Node 24).
- **PHP is removed**: `dashboard/api.php` is deleted once `tests/api-smoke.ps1` passes against the Node server. Laragon is no longer required.

---

## 2. Strict File Ownership Matrix (Zero-Conflict Boundary)

| Module / Layer | Owner AI | Allowed File Paths (Strict) | Forbidden Files |
| :--- | :--- | :--- | :--- |
| **Architecture & Contract** | **Claude (Tech Lead)** | `SPEC.md`, `specs/**` | `server/**`, `*.ps1` |
| **100% Frontend Mission Control UI** | **Claude (Frontend)** | `dashboard/index.html`, `dashboard/*.css`, `dashboard/*.js` | `server/**`, `*.ps1` |
| **Backend Server, Scripts, Tests & Docs** | **Antigravity (`Gemini 4 Argon`)** | `server/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `dashboard/api.php`, `*.ps1`, `tests/**`, `.github/**`, `antigravity/**`, `claude/**`, `codex/**`, `templates/**`, `README*.md`, `GEMINI.md`, `.gitignore` | `SPEC.md`, `dashboard/*.html`, `dashboard/*.css`, `dashboard/*.js` |

---

## 3. API Contract (`/api?action=<action>`, v3.0 — v4.0 additions in §7.5)

Every action keeps the **exact request and response JSON of v2.2** (keys, types, status codes); only the transport changes from `dashboard/api.php` to `/api`. All responses are JSON `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }` with the status codes listed here.

### 3.0. Request Security (applies to every request)
- The server listens on `127.0.0.1` only.
- **`Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`** (DNS-rebinding guard), else `403`.
- **Every `POST`** must satisfy ALL of the following, otherwise `403` (`415` for media type):
  1. Header `X-MAW-Request: 1` (custom header ⇒ browsers must preflight, and preflight is never approved).
  2. Media type (part before `;`, trimmed, lower-cased) is exactly `application/json`.
  3. `Origin`, if present, must equal `http://<Host header>`. `Origin: null` is rejected.
  4. `Sec-Fetch-Site`, if present, must be `same-origin` or `none`.
- Request body limit **256 KB** (`413`); invalid JSON ⇒ `400`.
- `OPTIONS` returns `204` with **no** `Access-Control-Allow-*` headers.
- Unknown action ⇒ `400`; wrong HTTP method for an action ⇒ `405`.
- Prompt limit: **20000** characters (`dispatch` and `run_job`).
- Response headers on every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. JSON: `Content-Type: application/json; charset=utf-8`. For `/`: `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.

### 3.1. `GET /api?action=status`
Returns `bridge`, `tools`, `conversations`, `projects`, `git_info`, `notify_config`, `jobs`, `audit`, plus `"api_version": "3.0"` and `"features": ["agents", "sse"]`.
- `tools.claude.version` / `tools.codex.version`: **detected** via `--version` (cached ≤ 1h), `null` when unknown. `tools.node.version` = `process.version`.
- `audit` keys: `total_calls`, `total_prompt_chars`, `total_input_tokens`, `total_output_tokens`, `total_cost_usd`, `avg_cost_per_call_usd`, `by_tool`, `cost_by_tool`, `cost_by_model`, `by_role`, `verdicts`, `recent_logs`.
- `notify_config`: `{ "desktop_toast": bool, "webhook_url": string, "telegram_chat_id": string, "telegram_bot_token_set": bool, "telegram_bot_token_masked": string|null }` — the raw bot token is **never** returned.
- `jobs[]`: `{ job_id, mode, role, agent, team?, project_name, status, exit_code, started_at, pid }`.

### 3.2. `GET /api?action=git_info&project_path=<path>`
Returns Git status for the selected project (`has_git`, `current_branch`, `modified_count`, `ahead`, `behind`, `branches`, `worktrees`, `recent_commits`).

### 3.3. `POST /api?action=spec_guard`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\multi-ai-workflow", "owner": "" | "antigravity" | "claude" | "codex" }`
- **Response JSON**: `{ "ok": true, "verdict": "PASS" | "WARN" | "FAIL", "has_spec": true, "has_git": true, "owner": "", "total_modified": 0, "frontend_count": 0, "backend_count": 0, "modified_files": [{ "path", "status", "category", "owner" }], "spec_endpoints": [...], "ownership_rules": [{ "owner", "allowed": [...], "forbidden": [...] }], "violations": [...], "warnings": [...] }`
- Produced by running `invoke-spec-guard.ps1 -Json` (same rules as v2.2: violations ⇒ `FAIL`; warnings ⇒ `WARN`).

### 3.4. `POST /api?action=init_spec`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\my-project", "project_name": "my-project" }`
- **Response JSON**: `{ "ok": true, "created": true, "git_initialized": false, "spec_path": "...", "message": "..." }`

### 3.5. `POST /api?action=dispatch`
- **Request JSON**: `{ "mode": "task"|"team"|"antigravity"|"claude"|"codex"|"council"|"auto-gate"|"spec-guard", "agent"?, "role": "...", "team"?, "model": "...", "effort": "...", "new_session"?: bool, "project_path": "...", "prompt": "...", "execute_antigravity": false }` (validation exactly as v2.2 §5.3).
- **Response JSON**: `{ "ok": true, "command": "& '...'", "dispatched": false, "output": "" }` — `command` is a human-readable PowerShell preview produced by the **same builder** that produces the spawn argument array for `run_job`.

### 3.6. `POST /api?action=run_job`
- **Request JSON**: same as 3.5 (without `execute_antigravity`).
- **Response JSON**: `{ "ok": true, "job_id": "job_20261024_...", "pid": 12345, "status": "RUNNING", "command": "& '...'", "agent"?, "team"? }`
- The server spawns `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script> <args...>` (argument array) **detached**, with stdout+stderr appended to the job log, and records `exit_code` + `JOB_FINISHED exit_code=<n>` when the process closes. The prompt is passed through a UTF-8 prompt file in the job dir (never on the command line).
- After the job finishes, `send-notification.ps1` is spawned (argument array) when notifications are configured.
- Jobs are not lost when the server restarts: on start, metas still `RUNNING` whose PID no longer exists ⇒ `FAILED`, `exit_code: null`. A job started by a server instance that has since exited keeps running; its status is derived from the `JOB_FINISHED` marker and the PID (same rules as v2.2, including the 60 s grace when `pid` is 0).

### 3.7. `GET /api?action=job_status&job_id=<id>&offset=<bytes>`
- **Response JSON**: `{ "ok": true, "job_id": "...", "status": "RUNNING"|"DONE"|"FAILED"|"CANCELLED", "exit_code": 0|null, "pid": 12345, "mode": "...", "role": "...", "agent"?, "team"?, "elapsed_sec": 8, "log_chunk": "...", "next_offset": 512, "full_log_size": 512 }`
- `log_chunk` never splits a UTF-8 multi-byte character (`next_offset` stops at a character boundary).
- Exit codes: `0` success/APPROVED, `2` auto-gate finished but not approved, `3` reviewer failure, `124` Antigravity wait timeout.

### 3.8. `POST /api?action=cancel_job`
- **Request JSON**: `{ "job_id": "job_20261024_..." }`
- **Response JSON**: `{ "ok": true, "job_id": "...", "status": "CANCELLED" }` — only a `RUNNING` job is killed (`taskkill /PID <pid> /T /F`, argument array); unknown id ⇒ `404`; not running ⇒ `409 { "ok": false, "error": "...", "status": "<current>" }`.

### 3.9. `POST /api?action=save_notify`
- **Request JSON**: `{ "desktop_toast": true, "webhook_url": "", "telegram_chat_id": "", "telegram_bot_token"?: string }` — `telegram_bot_token` **omitted or `null` keeps** the stored token; a string replaces it (`""` clears it).
- **Response JSON**: `{ "ok": true, "notify_config": <same shape as 3.1> }`

### 3.10. `POST /api?action=test_notify`
- **Response JSON**: `{ "ok": true, "result": { "desktop_sent": bool, "webhook_configured": bool, "webhook_sent": bool, "telegram_configured": bool, "telegram_sent": bool, "errors": { "desktop"?: "...", "webhook"?: "...", "telegram"?: "..." } } }`

### 3.11. `GET /api?action=job_stream&job_id=<id>&offset=<bytes>` (new in v3.0)
Server-Sent Events (`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no`):
- `event: log` — `data: {"chunk": "...", "next_offset": n}` whenever the log grows (chunks never split a UTF-8 character; check at least every 500 ms).
- `event: status` — `data: {"status": "...", "exit_code": n|null, "elapsed_sec": n}` on connect and on every status change.
- `: ping` comment every 15 s.
- After a terminal status (`DONE` / `FAILED` / `CANCELLED`) the remaining log is flushed, a final `status` event is sent and the stream is closed.
- Unknown job ⇒ plain `404` JSON (no stream). Client disconnect stops the watcher (no leaked timers / file handles).
- `job_status` polling remains available as the fallback.

---

## 4. Reviewer Output Contract
Every reviewer prompt (Claude `-Role reviewer`, Codex `review-diff` / `critic`) ends with: *finish with exactly two lines `SCORE: X/10` and `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`*. Parsers take the **last** `VERDICT:` / `SCORE:` line; the old keyword heuristic is only a fallback. Auto-Gate approves only when **every** reviewer returns `APPROVED` and the **minimum** score is ≥ 8.5.

---

## 5. Agents & Roles (v2.2) — any AI can take any role

### 5.1 Role matrix
Roles: `architect` (write/refresh SPEC.md only), `leader` (plan + delegate + review loop), `backend`, `frontend`, `reviewer`, `tester`.
Agents: `claude`, `antigravity`, `codex`. **Every (agent, role) pair is valid.**

| Role \ Agent | claude (`invoke-claude.ps1`) | codex (`invoke-codex.ps1`) | antigravity (`invoke-antigravity.ps1`) |
| :--- | :--- | :--- | :--- |
| architect | `-Role architect` (opus/high, Read,Edit,Write) | `-Role coder` | `-Action send-latest` (or `new`) |
| leader | `-Role leader` (opus/high, Read,Edit,Write,Bash) | `-Role coder` | `-Action send-latest` (or `new`) |
| backend | `-Role backend` (sonnet/medium, Read,Edit,Write,Bash) | `-Role coder` | `-Action send-latest` (or `new`) |
| frontend | `-Role frontend` | `-Role coder` | `-Action send-latest` (or `new`) |
| reviewer | `-Role reviewer -IncludeGitDiff` | `-Role review-diff` | `-Action send-latest` (or `new`) |
| tester | `-Role backend` flags | `-Role coder` | `-Action send-latest` (or `new`) |

### 5.2 `invoke-agent.ps1` (single entry point, used by the API, CLI and by leaders to delegate)
```
invoke-agent.ps1 -Agent claude|antigravity|codex -Role architect|leader|backend|frontend|reviewer|tester
                 -WorkDir <path> [-Prompt <text>] [-PromptFile <file>]
                 [-Team "backend=antigravity,frontend=claude,reviewer=codex"]   # leader only
                 [-ModelOverride <m>] [-EffortOverride <e>] [-NewSession] [-TimeoutSeconds 1800] [-DryRun]
```
- Prepends a **role brief** rendered from `antigravity/skills/claude-leader/templates/roles/<role>.md` (installed next to the scripts). Placeholders: `{{AGENT}}`, `{{ROLE}}`, `{{WORKDIR}}`, `{{TEAM_TABLE}}`, `{{DELEGATE_CMD}}`, `{{SCRIPTS_DIR}}`.
- Every brief: obey SPEC.md and its ownership matrix, stay inside the role's files. Non-leader briefs: **never delegate to other agents**. Reviewer brief ends with the SPEC §4 output contract.
- Leader brief: the team table, the exact delegation command, the loop: refresh SPEC.md → delegate backend/frontend → SPEC Guard with `-Owner` → review → fixes (max 2 rounds) → final summary with VERDICT/SCORE.
- Default team **only when `-Team` is omitted**: `backend=antigravity, frontend=claude, reviewer=codex`. With `-Team`, only the listed members (keys `backend`, `frontend`, `reviewer`).
- **Recursion guard**: env `MAW_DEPTH`; `-Role leader` with `MAW_DEPTH >= 1` ⇒ exit 2.
- Audit: env `MAW_ROLE` / `MAW_AGENT`. Exit code: the child's exit code (antigravity timeout ⇒ 124).

### 5.3 API modes (`dispatch` and `run_job`)
- `"mode": "task"` — `{ "agent": "claude|antigravity|codex", "role": "architect|backend|frontend|reviewer|tester", "model", "effort", "new_session": false, "project_path", "prompt" }` (prompt required).
- `"mode": "team"` — `{ "agent": "<leader>", "team": { "backend"?: "<agent>", "frontend"?: "<agent>", "reviewer"?: "<agent>" }, "model", "effort", "new_session": false, "project_path", "prompt" }` (≥ 1 member, prompt required; role is implicitly `leader`).
- Model/effort validated against the **executing** agent; antigravity tiers only with `new_session: true`.
- Legacy modes `claude` / `codex` / `antigravity` / `council` / `auto-gate` / `spec-guard` keep working.

---

## 6. v3.0 Migration Acceptance (Definition of Done)
1. `node --test server/tests` green; `npx tsc --noEmit` clean.
2. `tests/api-smoke.ps1` starts **the Node server** (`node server/main.ts --port <free port>` with `TMP`/`TEMP` pointing at a temp dir **containing a space**) and passes every v2.2 assertion, plus: `status.api_version == "3.0"` and `features` contains `sse`; wrong `Host` ⇒ `403`; `GET /` returns the dashboard with the CSP header; `/../SPEC.md` and `/server/main.ts` ⇒ `404`; `job_stream` for the space-path job delivers `log` events and a final `status` `DONE` with `exit_code: 0`.
3. Pester suites green; `install.ps1` / `doctor.ps1` check Node ≥ 22.18 (and no longer require PHP); `start-dashboard.ps1` works; CI uses `setup-node` 24 and drops `setup-php`.
4. Parity: every action in §3.1–3.10 returns the same keys as the v2.2 PHP API (checked by a parity test that compares key sets for `status`, `spec_guard`, `dispatch` task/team, `job_status`, `cancel_job` 404/409).
5. `dashboard/api.php` deleted; README / docs updated to "run `start-dashboard.ps1`".

---

## 7. Agent Registry (v4.0) — every AI is configuration

### 7.1 Files and merge rules
- Shipped default: `antigravity/skills/claude-leader/agents.json` (installed by `install.ps1` next to the scripts, checked by `doctor.ps1`).
- Optional user file: `$MAW_HOME/agents.json` (`MAW_HOME` defaults to `~/.maw`) with the same shape. Entries are merged **by `id`** (user fields override shipped fields; a new `id` adds an agent; `"enabled": false` hides one). `defaults` in the user file override the shipped `defaults`.
- One loader per side, both applying the same validation: `lib/maw-registry.ps1` (`Get-AgentRegistry`, `Get-AgentEntry`, `Resolve-AgentOwner`) and `server/lib/registry.ts`. An invalid entry is skipped with a warning (never crashes the server or a script); an invalid user file is ignored with a warning (`status.registry_warnings`).

### 7.2 Entry shape
```jsonc
{
  "version": 1,
  "defaults": { "team": { "backend": "antigravity", "frontend": "claude", "reviewer": "codex" }, "council": ["claude", "codex"], "implementer": "antigravity" },
  "agents": [{
    "id": "gemini",                        // ^[a-z][a-z0-9-]{1,23}$, unique
    "label": "Gemini CLI",
    "color": "#4285f4",                    // ^#[0-9a-fA-F]{6}$
    "enabled": true,
    "adapter": "cli",                      // "claude" | "codex" | "antigravity" (built-in wrappers) | "cli" (generic, §7.3)
    "aliases": ["gemini cli"],             // extra names matched in SPEC.md "Owner AI" cells (id and label always match)
    "detect": { "command": "gemini", "version_args": ["--version"] },
    "models": ["auto", "pro", "flash", "flash-lite"],   // allowed model overrides ([] = none)
    "efforts": [],                         // allowed effort overrides
    "capabilities": { "write": true, "review": true, "new_session": false, "sessions": false, "ide_send": false },
    "cli": { }                             // required when adapter == "cli" (§7.3)
  }]
}
```
- Built-in entries keep today's behaviour: `claude` (adapter `claude`, models / efforts as in v3), `codex` (adapter `codex`), `antigravity` (adapter `antigravity`; models `pro|flash|flash_lite`, only with a new session; capabilities `new_session`, `sessions`, `ide_send`).

### 7.3 Generic CLI adapter — `invoke-cli-agent.ps1`
```
invoke-cli-agent.ps1 -AgentId <id> -Role <role> -WorkDir <path> -PromptFile <file>
                     [-ModelOverride <m>] [-EffortOverride <e>] [-IncludeGitDiff] [-TimeoutSeconds 1800] [-DryRun]
```
The `cli` block:
```jsonc
{
  "command": "gemini",
  "prompt_via": "stdin",                   // "stdin" | "file_arg" ({prompt_file} in args) | "arg" ({prompt} in args)
  "args": ["-p", "Follow the task instructions given on stdin.", "--skip-trust", "-o", "json"],
  "role_args": { "reviewer": ["--approval-mode", "plan"], "*": ["--approval-mode", "yolo"] },
  "model_args": ["-m", "{model}"],
  "effort_args": [],
  "output": "gemini-json",                 // "text" | "gemini-json" (print .response, token usage from .stats, report .error)
  "max_arg_chars": 30000,                  // "arg" mode only: refuse (exit 1, clear message) when the rendered prompt is longer
  "pricing": { "input_per_mtok": 0, "output_per_mtok": 0 }    // optional, for the audit cost estimate
}
```
- Placeholders in `args` / `role_args` / `model_args` / `effort_args`: `{prompt}`, `{prompt_file}`, `{workdir}`, `{model}`, `{effort}`. `model_args` / `effort_args` are added only when an override is given. `role_args[<role>]` wins over `role_args["*"]`.
- Runs the command with an **argument array** (working directory = `-WorkDir`), **streams** stdout/stderr line by line, kills the whole process tree after `-TimeoutSeconds` and exits `124`. A missing command exits `127` with `"<label> is not installed (command '<command>' not found)."`. Otherwise the CLI's exit code is propagated.
- `-DryRun` prints `DRYRUN_COMMAND:` with the argument array and the prompt delivery, and exits 0.
- Reviewer role: the prompt gets `Get-ReviewDiff` (tracked + untracked) and the SPEC §4 reviewer contract, exactly like the Claude / Codex reviewers.
- Audit: one `multi-ai-audit.jsonl` line per run with `Tool = Agent = <id>`, `Role`, `Model`, tokens (from the parser when available, else chars / 3.8), `CostUsd` from `pricing` (0 when absent), `Score` / `Verdict` for reviewers.
- Shipped `cli` entries:
  - **`gemini`** (Gemini CLI, verified with 0.64): exactly the example above. Not signed in ⇒ the CLI's own error is shown in the log; `doctor.ps1` prints the sign-in hint (`run gemini once`, or set `GEMINI_API_KEY`).
  - **`cursor`** (Cursor Agent CLI, command `cursor-agent`): `prompt_via: "arg"`, `args: ["-p", "--output-format", "text", "{prompt}"]`, `role_args: { "*": ["--force"], "reviewer": [] }`, `model_args: ["-m", "{model}"]`, `models: ["auto"]`.
  - **`aider`** (command `aider`): `prompt_via: "file_arg"`, `args: ["--message-file", "{prompt_file}", "--yes-always", "--no-auto-commits", "--no-pretty", "--no-stream", "--no-check-update", "--no-show-model-warnings"]`, `role_args: { "reviewer": ["--dry-run"] }`, `model_args: ["--model", "{model}"]`, `models: ["sonnet", "opus", "haiku", "4o", "deepseek", "gemini"]`.

### 7.4 Everything else becomes registry-driven
- **`invoke-agent.ps1`**: `-Agent` = any enabled registry id (validated against the registry instead of `ValidateSet`). Adapter `claude|codex|antigravity` ⇒ today's wrapper; adapter `cli` ⇒ `invoke-cli-agent.ps1`. `-Team` values = any enabled id. The team table and delegation command in the leader brief use registry ids.
- **Council** (`invoke-council-review.ps1 -Reviewers "claude,codex,gemini"`, default `defaults.council`):
  - Runs every reviewer **in parallel** through `invoke-agent.ps1 -Role reviewer`, each with its own timeout (default 900 s). A reviewer that times out counts as `UNKNOWN`.
  - Prints `=== COUNCIL_RESULT <id>=<VERDICT>|<score> ... ===`.
  - Exit codes: `0` only when every reviewer is `APPROVED` and the minimum score is ≥ 8.5; `2` not approved; `3` any reviewer `UNKNOWN` or failed.
- **Auto-Gate** (`invoke-auto-gate.ps1 -Implementer <id> -Reviewers "<ids>"`, defaults from `defaults`): the implementer runs through `invoke-agent.ps1 -Role backend`; SPEC Guard uses `-Owner <implementer>` with the baseline; the review is a Council with `-Reviewers`.
- **SPEC Guard**: `-Owner` = any registry id. A matrix row belongs to **every** agent whose id, label or alias appears in its "Owner AI" cell. This fixes the v3 bug where a row like "Claude Opus + Antigravity" counted only for Antigravity. An unknown owner gives the existing "no row" warning.
- **`lib/maw-common.ps1` `Invoke-NativeProcess`** always redirects **and closes** stdin (new optional `-StdinText`: write it, then close). This fixes the v3 hang where `git status` never exits inside `Start-Job`, which froze every Council and Auto-Gate run (reproduced: hangs > 20 s; with stdin closed it finishes in 1 s).

### 7.5 API v4.0 (all v3 rules still apply)
- `GET status` adds:
  - `"api_version": "4.0"`; `features` gains `"registry"`.
  - `"agents": [{ id, label, color, adapter, enabled, installed, version, models, efforts, capabilities }]`. `installed` / `version` come from `detect` (cached ≤ 1 h); `claude` / `codex` keep their richer detection.
  - `"defaults": { team, council, implementer }` and `"registry_warnings": [...]`.
  - `tools` stays for compatibility (built from the same data). `bridge` / `conversations` stay as Antigravity extras.
- `dispatch` / `run_job`:
  - `task` / `team`: `agent` and team values ∈ enabled registry ids. Model / effort must be in the executing agent's `models` / `efforts`. Antigravity tiers still need `new_session: true`. `new_session` is only allowed for agents with `capabilities.new_session`.
  - `run_job` with an agent whose `installed` is false ⇒ `400 "<label> is not installed."` (`dispatch` previews still work).
  - `council` accepts `"reviewers": ["claude", "gemini"]` (≥ 1, each enabled with `capabilities.review`) ⇒ `-Reviewers`.
  - `auto-gate` accepts `"implementer"` (with `capabilities.write`) and `"reviewers"` ⇒ `-Implementer` / `-Reviewers`.
  - `execute_antigravity` (IDE quick-send) is only valid for an agent with `capabilities.ide_send`.
  - Job meta / `status.jobs[]` keep `agent` and `team`; council and auto-gate jobs add `reviewers` / `implementer`.
  - The job meta `command` is the command **actually executed** (with `-PromptFile <job prompt file>`), never the inline-prompt preview.
- `spec_guard`: `owner` ∈ `""` ∪ enabled registry ids.

## 8. v4.0 Acceptance (Definition of Done)
1. `npm run typecheck`, `npm test`, Pester and `tests/api-smoke.ps1` are green.
2. Unit tests:
   - Registry: merge, override, disable, invalid entry skipped, invalid user file ignored.
   - CLI adapter `-DryRun`: rendered argument arrays for gemini / cursor / aider in every role, placeholders, `max_arg_chars`; exit 127 for a missing command; exit 124 on timeout (fake CLI registered in a temp `MAW_HOME`).
   - SPEC Guard: multi-owner rows.
   - `Invoke-NativeProcess` inside `Start-Job` finishes (regression test for the hang).
3. api-smoke additions:
   - `status.agents` lists all six shipped agents with `installed` flags.
   - `dispatch` task / team with `gemini` / `cursor` / `aider` builds `invoke-agent.ps1` commands.
   - `council` with `reviewers` builds `-Reviewers`.
   - `run_job` for an agent that is not installed ⇒ 400.
   - A **real Council run** on a temp git repo with a fake CLI reviewer (registered in a temp `MAW_HOME`) finishes with a `COUNCIL_RESULT` line — no hang.
4. Docs:
   - README, `claude/CLAUDE.md`, `antigravity/rules/*` and `codex/AGENTS.md` describe the registry, how to add an AI, and the three new agents.
   - `doctor.ps1` lists every registry agent with installed / version / sign-in hint.

---

## 9. v5.0 — Managing many AIs (parallel feature streams)

v5 adds the feature set from the 2026-10-25 market survey (Claude Squad, Conductor, Kilo Agent Manager, Cline Kanban, CCManager, Agent Deck, opcode, Copilot coding agent…). The work is split into **5 independent streams** that are built in parallel, each on its own git worktree and branch, on top of the **plugin foundation (F0)**. F0 exists so that no two streams edit the same file.

Each stream has:
- one **stream lead**: a Claude session doing the frontend and acting as the architect of its stream;
- one **backend developer**: its own Antigravity conversation.

### 9.0 Plugin foundation (F0) — built before the streams start
- **Server features**:
  - Each feature lives in `server/features/<name>/` and exports `feature` from `index.ts`:
    ```ts
    export const feature: MawFeature = {
      name: 'checkpoints',                      // ^[a-z][a-z0-9-]{1,31}$
      routes: { 'checkpoint_list': { method: 'GET', handler }, 'checkpoint_restore': { method: 'POST', handler } },
      status?: (ctx) => Promise<Record<string, unknown>>,   // merged into status.feature_data[<name>]
      ui?: { script: 'feat-checkpoints.js', style?: 'feat-checkpoints.css' },
    };
    ```
  - `http.ts` imports every `server/features/*/index.ts` at startup (sorted by name). A duplicate action name or an invalid feature fails startup with a clear message.
  - Feature routes get the same §3.0 security, JSON body parsing and `ApiValidationError` handling as the built-in actions.
  - `status` adds `"feature_data": {}`, `"ui_features": [{ name, script, style? }]`, and every feature name in `features`.
  - `ctx` = `{ paths, registry, readJobs, startJob(body) }`, so features can start jobs through the same runner as `run_job`.
- **Script hooks**:
  - `lib/maw-hooks.ps1` provides `Invoke-MawHooks -Event <event> -Context <hashtable>`. It dot-sources every `scripts/hooks/<event>/*.ps1` in name order.
  - Each hook gets `$Context` and may return `@{ Block = $true; Reason = '...' }`.
  - Events:
    - `job-start` and `job-finish` (called by the job runner);
    - `round-start`, `after-implement` and `before-review` (called by `invoke-auto-gate.ps1`);
    - `before-agent` (called by `invoke-agent.ps1` before it runs a child; a block there exits `5` with the reason).
  - Streams add hook files and never edit the runner, Auto-Gate or `invoke-agent.ps1`.
- **Feature data**: `$MAW_HOME/data/<feature>/` (JSON / JSONL). Each feature reads and writes only its own folder.
- **Frontend**:
  - `index.html` exposes `window.MAW`:
    - helpers: `api`, `t`, `toast`, `esc`, `badge`, `fmt`, `state`, `on(event, fn)`, `addI18n(lang, dict)`;
    - `addTab({ id, title, render })`, `addJobAction({ id, label, when(job), run(job) })`, `addProjectAction({ id, label, run(project) })`, `addHeaderItem(el)`.
  - Events: `data` (after every status load), `job-start`, `job-end`, `project-change`, `lang`.
  - `index.html` loads each `ui_features[].script` / `style` as `dashboard/<file>`. A feature's UI lives only in `dashboard/feat-<name>.js` / `.css`.
- **Antigravity parallel conversations**:
  - `invoke-antigravity.ps1 -Action new` sets `ANTIGRAVITY_PROJECT_ID`, taken from the `projectId` in the metadata of an existing conversation for the workspace. Verified: without it the hub answers `project_id is required when providing project_env_config`; with it a new conversation starts.
  - It also accepts `-ConversationId <id>` for follow-ups, so several conversations can run in parallel, one per worktree.

### 9.1 Stream ownership (on top of §2)
| Stream | Owns (server / scripts / UI) | Features |
| :--- | :--- | :--- |
| **S1 isolation** | `server/features/{checkpoints,worktrees}/**`, `scripts/hooks/*/10-checkpoint*.ps1`, `scripts/maw-worktree*.ps1`, `dashboard/feat-{checkpoints,worktrees}.*`, `specs/s1-*.md` | #9 checkpoints + rollback, #1 worktree + branch per job with merge / PR, #3 fork a job, #2 best-of-N |
| **S2 board** | `server/features/{tasks,github,schedules,playbooks}/**`, `scripts/hooks/*/20-task*.ps1`, `dashboard/feat-{tasks,github}.*`, `specs/s2-*.md` | #4 task queue / kanban with dependencies + concurrency limits, #5 retry / reassign / resume, #6 templates + team presets, #13 GitHub issues / PRs via `gh` |
| **S3 attention** | `server/features/{health,inbox,telegram,timeline,mcp}/**`, `scripts/hooks/*/30-*.ps1`, `server/mcp/**`, `dashboard/feat-{health,inbox,timeline,mcp}.*`, `specs/s3-*.md` | #7 attention inbox (running / waiting / idle / error) + two-way Telegram, #14 MCP config manager + dashboard as an MCP server |
| **S4 cost & quality** | `server/features/{budget,fallback,checks,scoreboard,policy}/**`, `scripts/hooks/*/40-*.ps1`, `dashboard/feat-{budget,checks,scoreboard,policy}.*`, `specs/s4-*.md` | #11 budgets + quota / rate-limit tracking + fallback routing, #12 test gate + Checks panel + agent scoreboard |
| **S5 review** | `server/features/{review,files,steer}/**`, `dashboard/feat-{review,files,steer}.*`, `specs/s5-*.md` | #8 diff review UI with inline comments sent back as a fix prompt + per-file / per-hunk accept / reject, #10 steer a job (see 9.2) |

- Within a stream, the Claude lead owns `dashboard/feat-*` and `specs/s<n>-*.md`; Antigravity owns the stream's `server/**` and `scripts/**` paths.
- Shared files (`SPEC.md`, `index.html`, `http.ts`, the runner, Auto-Gate, `invoke-agent.ps1`, registry) are **not** edited by streams. A stream that needs a change there writes it under "Requests to Tech Lead" in its `specs/s<n>-*.md`, and the Tech Lead applies it.
- Cross-stream contracts:
  - S2 cards start work through `ctx.startJob`.
  - S1 exposes `worktree_create` / `worktree_merge` actions, which S2 / S4 may call over HTTP.
  - S4 fallback routing works only through the `before-agent` hook. It returns `@{ Block = $true }` plus a suggested agent; it does not rewrite other streams' code.

- Per-stream briefs (items, order, contracts): `specs/streams/s1…s6-*.md` + `specs/streams/README.md` (common rules).

### 9.2 Constraints and decisions
- **Zero runtime dependencies stays.** #10 "real interactive terminals" would need a native PTY module (node-pty), so it is replaced by **steer**:
  - send a follow-up to a running Antigravity job (`send-message` to its conversation);
  - "continue" a finished job with the same agent, using its resume / continue flag where the registry entry declares one (`cli.resume_args`);
  - otherwise a new job that starts with the previous summary.
- Diff rendering is done in-house (no CDN libraries, CSP stays `script-src 'self'`).
- GitHub uses the `gh` CLI with an argument array. When `gh` is missing or not logged in, the feature reports that and does nothing else.
- Every destructive action (restore checkpoint, discard worktree, reject hunk, merge) asks for confirmation in the UI and is logged in the audit.
- Windows PowerShell 5.1 and Node 22.18+ as before. All tests run on Windows.

### 9.3 Stream Definition of Done
1. `specs/s<n>-*.md`: the detailed design, written by the lead before coding, with the actions and data shapes.
2. Backend tests (`node --test`, Pester) and the frontend checked in a browser against a running server. api-smoke still green.
3. Antigravity's backend reviewed by the lead (score ≥ 8.5, max 2 rounds), plus a final Codex review of the branch diff.
4. The branch merges cleanly onto the integration branch after F0; no file outside the stream's ownership is changed.

### 9.4 Video parity — "Agent Team" command center (user request 2026-10-25)
The user shared two demo videos of a Vietnamese build of **Maestro** ([pedramamini/Maestro](https://github.com/pedramamini/Maestro), AGPL-3.0, Electron). They show an "Agent Team" mode on top of it, and the user wants the same capabilities here.
**No Maestro code may be copied** (AGPL). We re-implement the behaviour in our own stack (zero-dependency Node server + vanilla UI + PowerShell).

What the videos show, and where it lands:

| # | Capability seen in the videos | Stream |
| :--- | :--- | :--- |
| V1 | **3-column workspace**: left = teams → agents (name, platform, status dot, git badge, bookmark); centre = chat with the selected agent (one tab per conversation, `+` for a new one); right = Files / History / Auto Run. Top bar: agent, branch, `+added −removed` lines, cost, context-window meter | **S6** UI (Claude) |
| V2 | **Persistent agents**: named, in a group/team, platform + model + effort, working dir, custom CLI args, env vars, per-message hooks. Platform availability is detected with a refresh button ("Sẵn có" / "Không tìm thấy") | S6 (registry-backed) |
| V3 | **Multi-turn chat per agent** with session resume (Claude `--resume`, Codex `exec resume`, Gemini `--resume`, Antigravity conversation id). Per message you can switch platform / model / effort. A message queue applies while the agent is busy ("n mục đang chờ"); text goes into the running session where the platform supports it (Antigravity `send-message`). Status line "<agent> đang suy nghĩ… · đã chạy 2m18s · <task> · Dừng" | S6 |
| V4 | **Team builder** ("Thiết lập Agent Team"): start from a template (Full Team / empty), shared settings (dir, platform, model, effort, write scope, writable dirs). Members are Lead, Deputy, Planner, Worker, Testing, Hacker, each with: role name, working style (persistent chat / per task / new chat per task), persona, "may delegate to other roles", responsibility, delegation/reporting, output, permissions, and an optional per-role override (dir, platform, write scope). Save to a profile library, save or update a team template | S6 |
| V5 | **Handoff protocol**: Lead dispatches `handoffId`s to members; each member's result returns as `[Handoff <id>] Source <agent> completed …` into the Lead's chat. A "ĐANG CHỜ (n)" pending list, toasts with summary and duration per finished handoff, and a Lead summary table at the end | S6 (+ S3 inbox) |
| V6 | **Auto-recovery**: retry on API errors (429 / 529 / overloaded, backoff 30 s → 30 min) and when tokens run out (wait for the limit reset), then continue | S4 |
| V7 | **Re-login flow**: an auth error shows an error card with "Thử lại". The login dialog runs the platform's login command (`claude /login`, `codex login`, `gemini`). Credentials are shared by all agents on that platform. Without a PTY we open a **real terminal window** running the login command and offer "Retry" when it closes | S3 |
| V8 | **Agent context menu**: rename, edit agent, role setup, duplicate, bookmark, move to group, git log / diff / pull / push, switch branch, create PR, configure worktree, copy agent id, delete. Deleting a group moves its agents out instead of deleting them | S6 menu; git actions call S1 / S2 APIs |
| V9 | **Files panel**: tree of the working dir with git status dots, search, open, toggle dotfiles, refresh; plus History | S5 |
| V10 | **Auto Run playbooks**: markdown checklists processed task by task, each in a fresh session | S2 |
| V11 | Run an agent on a remote machine over SSH | **deferred** (not in v5) |

### 9.5 Stream S6 — Agent workspace (added for 9.4)
- **Owns**: `server/features/{agents-ws,teams,chat,handoffs,memory}/**`, `scripts/hooks/*/60-*.ps1`, `dashboard/feat-{workspace,teams,palette}.*`, `specs/s6-*.md`.
- **Data**: `$MAW_HOME/data/agents-ws/` holds agents, groups, teams, role profiles and team templates as JSON; conversations are stored as JSONL per conversation.
- A chat turn is a job (same runner, so logs, SSE, cancel, notifications and audit all keep working) with `mode: "chat"`, `agent_profile_id`, `conversation_id` and the platform's resume token.
- The S6 lead also owns the **3-column layout** as a full-screen "Workspace" view inside `index.html` through a new `MAW.addView()`. The Tech Lead adds that hook to F0.
- The current dashboard stays available as the "Bảng điều khiển" view.
- Handoffs reuse team mode. The Lead's brief gains a `dispatch` tool, implemented as `invoke-agent.ps1` + a handoff record; member results are appended to the Lead's conversation and fire the `handoff-done` event (toast + inbox).

### 9.6 Beyond the videos — improvements and extra features (user request 2026-10-25)
"Weakness in the video" = something visible in the demo that we must do better.

**A. Fixes for weaknesses visible in the videos**

| # | Weakness in the video | Our improvement | Stream |
| :--- | :--- | :--- | :--- |
| B1 | Every member worked directly in the same folder (`D:\workflow`), so members can overwrite each other | Each handoff runs in its **own worktree / branch**. SPEC Guard checks every member's diff against its role's write scope. After review it is merged automatically (or a conflict view opens) | S1 + S6 |
| B2 | One expired login stopped the whole team (Lead and members all failed with "OAuth session expired") | **Pre-flight health check** before every dispatch: installed, version, logged in, quota left. It is a CLI probe and spends no LLM tokens. A failed platform triggers an automatic **fallback** to another agent from the registry (configurable per role), plus a one-click re-login | S3 + S4 |
| B3 | "Team readiness check" took 5+ minutes and LLM tokens, and the Lead found contradictions ("6 agents listed as claude-code, actually 3 providers") | Readiness is **built in and free** (B2 probes). The registry is the single source of truth. Each turn records the **actual model** the CLI reports, not the configured one | S3 + S6 |
| B4 | Handoff results are free text; the Lead re-reads and re-types them into tables | **Structured handoff result** with a JSON schema (`status`, `summary`, `files_changed`, `evidence`, `blockers`, `cost`), validated. The UI renders it as cards and tables, and the Lead's next turn gets a compact summary (no copy-paste) | S6 |
| B5 | Cost showed `$0.00`; there was no budget | Cost per turn / handoff / team run (parsed or estimated), **budgets** per run / day / project with warn → block, and cost per approved task | S4 |
| B6 | Context-window meter only | Context meter plus **automatic compaction**: when a persistent chat passes ~70 %, the agent writes a summary and a new session starts from it. Members return summaries only, so the Lead's context stays small | S6 |
| B7 | Text messages are injected into a running session, but there is no stop / undo | **Checkpoint before every turn and handoff**, timeline, one-click rollback (all agents, including edits made through bash) | S1 |
| B8 | No independent quality gate; the Lead "trusts" the members | Our existing **reviewer X/10 + Council + SPEC Guard** gate every handoff before merge, plus a **test gate** (configured lint / typecheck / test commands) | S4 + S6 |

**B. Features the videos do not have**

| # | Feature | Stream |
| :--- | :--- | :--- |
| N1 | **Kanban / queue with dependencies + concurrency limits per platform**. Cards can come from the Lead's plan, GitHub issues or Auto Run playbooks | S2 |
| N2 | **Best-of-N**: same task to 2–4 agents in separate worktrees; tests + Council pick the winner | S1 |
| N3 | **Agent scoreboard + auto-assign**: approval rate, average score, fix rounds, cost per approved task, time — per agent × role. The team builder suggests the best agent for each role from this data | S4 |
| N4 | **Diff review UI**: per-file / per-hunk accept / reject; inline comments become the next fix prompt | S5 |
| N5 | **Attention inbox + two-way Telegram**: approve, reject, reply or retry from the phone; morning / evening digest | S3 |
| N6 | **Policies per role**: protected paths, a command allow / deny list (e.g. Hacker may not `git push`), secret redaction in logs and prompts, approvals for dangerous commands (`rm -rf`, `git push --force`, `DROP`) | S4 |
| N7 | **Project memory**: decisions log / ADRs appended from handoff results. Agents get the relevant entries in their brief, which cuts repeated explanations | S6 |
| N8 | **Team-run timeline (Gantt) + replay** of who did what and when, exportable as an HTML / Markdown report to share | S3 |
| N9 | **Scheduled runs** (cron-like): nightly council review of uncommitted work, weekly dependency / security audit, a playbook at a fixed time | S2 |
| N10 | **Team config in the repo**: `.maw/team.json` and role profiles versioned with the project; import / export templates; share a team between projects | S6 |
| N11 | **Global command palette (Ctrl+K)**: any action, agent, project or template from the keyboard. It extends the current project switcher | S6 (UI) |
| N12 | **Doctor in the UI**: install / login / version status for every platform, update check, one-click "open login terminal" | S3 |
| N13 | **GitHub**: issue → card, approved branch → PR with an AI-written description, PR review comments / CI failures → fix round | S2 |
| N14 | **MCP**: one MCP config pushed to all agents, and the dashboard itself exposed as an MCP server, so the Lead delegates through tools | S3 |

Priority inside each stream: the A items first (they make the core flow reliable), then the B items in the order listed.

## 10. v6.0 — Accounts, quota and limit handoff (S7, user request 2026-10-25)
Full design: [`specs/s7-design.md`](specs/s7-design.md). Summary:
- **Several accounts per AI** (`~/.maw/accounts.json`, paths only, never credentials): a run selects an account by setting the CLI's own config-home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) for that process only; every installed agent keeps an implicit `default` account.
- **Quota per account** (5h / 7d windows where the provider reports them, else errors and estimates), refreshed cheaply in the background and before every routing decision.
- **Proactive routing** in the server before a job is spawned: below `switch_at` (default 85 %) on the requested account, else another account of the same agent, else a role fallback; modes `auto` / `suggest` / `off`.
- **Limit handoff** for chats: switch to an account / agent with room and carry a handoff letter (summary or last 10 messages).

| Part | Owner | Paths |
| :--- | :--- | :--- |
| Server, scripts, tests | Antigravity | `server/features/{accounts,quota}/**`, the S4 fallback / recovery and S6 chat changes listed in the design, `invoke-agent.ps1` / `invoke-cli-agent.ps1` `-Account`, `scripts/lib/**`, `tests/**` |
| UI and spec | Claude | `dashboard/**`, `specs/s7-design.md`, this section |

Out of scope: browser profiles, copying cookies or credentials, macros on provider websites, pooling or stretching any provider's quota.
