# Project Specification (`SPEC.md`): Multi-AI Mission Control Dashboard (v3.0)

## 1. Architecture & Tech Stack
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
| **Architecture & Contract** | **Claude (Tech Lead)** | `SPEC.md` | `server/**`, `*.ps1` |
| **100% Frontend Mission Control UI** | **Claude (Frontend)** | `dashboard/index.html`, `dashboard/*.css`, `dashboard/*.js` | `server/**`, `*.ps1` |
| **Backend Server, Scripts, Tests & Docs** | **Antigravity (`Gemini 4 Argon`)** | `server/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `dashboard/api.php`, `*.ps1`, `tests/**`, `.github/**`, `antigravity/**`, `claude/**`, `codex/**`, `templates/**`, `README*.md`, `GEMINI.md`, `.gitignore` | `SPEC.md`, `dashboard/*.html`, `dashboard/*.css`, `dashboard/*.js` |

---

## 3. API Contract (`/api?action=<action>`, v3.0)

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
