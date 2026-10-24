# Project Specification (`SPEC.md`): Multi-AI Mission Control Dashboard (v2.2)

## 1. Architecture & Tech Stack
- **Backend Runtime**: PHP 8.x (`dashboard/api.php`) served via Laragon (`http://localhost/multi-ai-workflow/dashboard/` or `http://multi-ai-workflow.test/dashboard/`).
- **PowerShell Orchestration Suite (`antigravity/skills/claude-leader/scripts/`)** — must run on Windows PowerShell 5.1:
  - `invoke-claude.ps1`: Claude Opus / Sonnet / Haiku / Fable wrapper with token/cost telemetry.
  - `invoke-codex.ps1`: OpenAI Codex CLI wrapper with token/cost telemetry.
  - `invoke-antigravity.ps1`: Zero-Config Live Self-Healing Bridge to Antigravity IDE (`Gemini 4 Argon`).
  - `invoke-council-review.ps1`: Parallel Dual-AI Review (Claude Sonnet + OpenAI Codex simultaneously).
  - `invoke-spec-guard.ps1`: 0-Token Static `SPEC.md` Contract & File Ownership Boundary Guard.
  - `invoke-auto-gate.ps1`: Automated Bounded Loop (`Implement -> SPEC Guard -> Council Review -> Auto-Fix`).
  - `send-notification.ps1`: Native Windows 10/11 Toast Notification + Webhook (Discord/Slack) + Telegram Bot pusher.
  - `lib/maw-common.ps1`: Shared helpers dot-sourced by the scripts above (native argument quoting, verdict parsing, untracked-file diff).
  - `invoke-agent.ps1` + `../templates/roles/*.md`: single entry point that runs **any agent in any role** with a role brief (§5).
- **Frontend Stack**: Single-file Bilingual (`🇻🇳 VI | 🇬🇧 EN`) HTML5 + Tailwind CSS + Lucide Icons (`dashboard/index.html`) — **100% authored by Claude**.
- **Tests**: Pester 5 (`tests/*.Tests.ps1`) + PHP smoke test (`tests/api-smoke.ps1` against `php -S`), run in CI.

---

## 2. Strict File Ownership Matrix (Zero-Conflict Boundary)

| Module / Layer | Owner AI | Allowed File Paths (Strict) | Forbidden Files |
| :--- | :--- | :--- | :--- |
| **Architecture & Contract** | **Claude (Tech Lead)** | `SPEC.md` | `dashboard/api.php`, `*.ps1` |
| **100% Frontend Mission Control UI** | **Claude (Frontend)** | `dashboard/index.html`, `dashboard/*.css`, `dashboard/*.js` | `dashboard/api.php`, `*.ps1` |
| **Backend API, Scripts, Tests & Docs** | **Antigravity (`Gemini 4 Argon`)** | `dashboard/api.php`, `*.ps1`, `tests/**`, `.github/**`, `antigravity/**`, `claude/**`, `codex/**`, `templates/**`, `README*.md`, `GEMINI.md`, `.gitignore` | `SPEC.md`, `dashboard/*.html`, `dashboard/*.css`, `dashboard/*.js` |

---

## 3. API Contract (`dashboard/api.php` v2.2)

### 3.0. Request Security (applies to every request)
- Only loopback clients (`REMOTE_ADDR`) and trusted `Host` headers (`localhost`, `127.0.0.1`, `[::1]`, `*.test`, `*.local`).
- **Every `POST`** must satisfy ALL of the following, otherwise `403` (`415` for media type):
  1. Header `X-MAW-Request: 1` (custom header ⇒ browsers must preflight, and preflight is never approved).
  2. Media type (part before `;`, trimmed, lower-cased) is exactly `application/json`.
  3. `Origin`, if present, must be a real origin whose host equals the request host. `Origin: null` is rejected.
  4. `Sec-Fetch-Site`, if present, must be `same-origin` or `none`.
- `OPTIONS` keeps returning `204` with **no** `Access-Control-Allow-*` headers.
- Prompt limit: **20000** characters (`dispatch` and `run_job`).

### 3.1. `GET api.php?action=status`
Returns `bridge`, `tools`, `conversations`, `projects`, `git_info`, `notify_config`, `jobs`, `audit`.
- `tools.claude.version` / `tools.codex.version`: **detected** via `--version` (cached ≤ 1h in temp), `null` when unknown. No hard-coded version strings.
- `audit` keys: `total_calls`, `total_prompt_chars`, `total_input_tokens`, `total_output_tokens`, `total_cost_usd`, `avg_cost_per_call_usd`, `by_tool`, `cost_by_tool`, `cost_by_model`, `by_role`, `verdicts`, `recent_logs`. The fabricated `estimated_tokens_saved` / `estimated_cost_saved_usd` fields are **removed**.
- `notify_config`: `{ "desktop_toast": bool, "webhook_url": string, "telegram_chat_id": string, "telegram_bot_token_set": bool, "telegram_bot_token_masked": string|null }` — the raw bot token is **never** returned.
- `jobs[]`: `{ job_id, mode, role, project_name, status, exit_code, started_at, pid }`.

### 3.2. `GET api.php?action=git_info&project_path=<path>`
Returns Git status for the selected project (`has_git`, `current_branch`, `modified_count`, `ahead`, `behind`, `branches`, `worktrees`, `recent_commits`).

### 3.3. `POST api.php?action=spec_guard`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\multi-ai-workflow", "owner": "" | "antigravity" | "claude" | "codex" }`
- **Response JSON**: `{ "ok": true, "verdict": "PASS" | "WARN" | "FAIL", "has_spec": true, "has_git": true, "owner": "", "total_modified": 0, "frontend_count": 0, "backend_count": 0, "modified_files": [{ "path", "status", "category", "owner" }], "spec_endpoints": [...], "ownership_rules": [{ "owner", "allowed": [...], "forbidden": [...] }], "violations": [...], "warnings": [...] }`
- `violations` (⇒ `FAIL`): with `owner` set, a modified file that matches a `Forbidden` pattern of that owner's rows or no `Allowed` pattern of that owner's rows.
- `warnings` (⇒ `WARN` when no violations): missing SPEC.md, unfilled template placeholders, not a git repository, modified files covered by no row's `Allowed` patterns.
- `modified_files[].owner` comes from the ownership matrix when a row matches, else the extension heuristic.

### 3.4. `POST api.php?action=init_spec`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\my-project", "project_name": "my-project" }`
- **Response JSON**: `{ "ok": true, "created": true, "git_initialized": false, "spec_path": "...", "message": "..." }`

### 3.5. `POST api.php?action=dispatch` (modes `task` / `team` added in v2.2 — see §5.3)
- **Request JSON**: `{ "mode": "antigravity"|"claude"|"codex"|"council"|"auto-gate"|"spec-guard", "role": "...", "model": "...", "effort": "...", "project_path": "...", "prompt": "...", "execute_antigravity": false }`
- **Response JSON**: `{ "ok": true, "command": "& '...'", "dispatched": false, "output": "" }`

### 3.6. `POST api.php?action=run_job` (Live Web Job Runner for ALL Modes)
- **Request JSON**: same as 3.5 (without `execute_antigravity`).
- **Response JSON**: `{ "ok": true, "job_id": "job_20261024_...", "pid": 12345, "status": "RUNNING", "command": "& '...'" }`

### 3.7. `GET api.php?action=job_status&job_id=<id>&offset=<bytes>`
- **Response JSON**: `{ "ok": true, "job_id": "...", "status": "RUNNING"|"DONE"|"FAILED"|"CANCELLED", "exit_code": 0|null, "pid": 12345, "mode": "...", "role": "...", "elapsed_sec": 8, "log_chunk": "...", "next_offset": 512, "full_log_size": 512 }`
- `log_chunk` never splits a UTF-8 multi-byte character (`next_offset` stops at a character boundary).
- A process that exits without writing the `JOB_FINISHED` marker ⇒ `FAILED` with `exit_code: null`.
- Exit codes: `0` success/APPROVED, `2` auto-gate finished but not approved, `3` reviewer failure, `124` Antigravity wait timeout.

### 3.8. `POST api.php?action=cancel_job`
- **Request JSON**: `{ "job_id": "job_20261024_..." }`
- **Response JSON**: `{ "ok": true, "job_id": "...", "status": "CANCELLED" }` — only a `RUNNING` job is killed; otherwise `409 { "ok": false, "error": "...", "status": "<current>" }`.

### 3.9. `POST api.php?action=save_notify`
- **Request JSON**: `{ "desktop_toast": true, "webhook_url": "", "telegram_chat_id": "", "telegram_bot_token"?: string }` — key `telegram_bot_token` **omitted or `null` keeps** the stored token; a string replaces it (`""` clears it).
- **Response JSON**: `{ "ok": true, "notify_config": <same shape as 3.1> }`

### 3.10. `POST api.php?action=test_notify`
- **Response JSON**: `{ "ok": true, "result": { "desktop_sent": bool, "webhook_configured": bool, "webhook_sent": bool, "telegram_configured": bool, "telegram_sent": bool, "errors": { "desktop"?: "...", "webhook"?: "...", "telegram"?: "..." } } }`

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
| leader | **new** `-Role leader` (opus/high, Read,Edit,Write,Bash) | `-Role coder` | `-Action send-latest` (or `new`) |
| backend | **new** `-Role backend` (sonnet/medium, Read,Edit,Write,Bash) | `-Role coder` | `-Action send-latest` (or `new`) |
| frontend | `-Role frontend` | `-Role coder` | `-Action send-latest` (or `new`) |
| reviewer | `-Role reviewer -IncludeGitDiff` | `-Role review-diff` | `-Action send-latest` (or `new`) |
| tester | **new** `-Role backend` flags | `-Role coder` | `-Action send-latest` (or `new`) |

### 5.2 `invoke-agent.ps1` (single entry point, used by the API, CLI and by leaders to delegate)
```
invoke-agent.ps1 -Agent claude|antigravity|codex -Role architect|leader|backend|frontend|reviewer|tester
                 -WorkDir <path> [-Prompt <text>] [-PromptFile <file>]
                 [-Team "backend=antigravity,frontend=claude,reviewer=codex"]   # leader only
                 [-ModelOverride <m>] [-EffortOverride <e>] [-NewSession] [-TimeoutSeconds 1800]
```
- Prepends a **role brief** rendered from `antigravity/skills/claude-leader/templates/roles/<role>.md` (installed next to the scripts). Placeholders: `{{AGENT}}`, `{{ROLE}}`, `{{WORKDIR}}`, `{{TEAM_TABLE}}`, `{{DELEGATE_CMD}}`, `{{SCRIPTS_DIR}}`.
- Every brief: obey SPEC.md and its ownership matrix, stay inside the role's files. Non-leader briefs: **never delegate to other agents**. Reviewer brief ends with the SPEC §4 output contract.
- Leader brief: the team table, the exact delegation command
  `powershell -NoProfile -ExecutionPolicy Bypass -File "{{SCRIPTS_DIR}}\invoke-agent.ps1" -Agent <agent> -Role <role> -WorkDir "{{WORKDIR}}" -PromptFile <file>`
  (write the sub-task to a temp UTF-8 file first), the loop: refresh SPEC.md → delegate backend/frontend (may run in parallel only if their files don't overlap) → run SPEC Guard with `-Owner` → delegate review → send fixes back (max 2 rounds) → final summary with VERDICT/SCORE.
- Default team when `-Team` is omitted: `backend=antigravity, frontend=claude, reviewer=codex`. A team member may be the same agent as the leader.
- **Recursion guard**: env `MAW_DEPTH` (default 0). invoke-agent sets `MAW_DEPTH = depth + 1` for the child process. `-Role leader` with `MAW_DEPTH >= 1` ⇒ error, exit 2.
- Audit: sets env `MAW_ROLE=<role>` and `MAW_AGENT=<agent>`; invoke-claude/codex write `Role = $env:MAW_ROLE` when present (antigravity calls are audited by invoke-agent itself with Tool `antigravity`).
- Exit code: the child's exit code (antigravity timeout ⇒ 124).
- Model/effort: claude & codex as today; antigravity `-ModelOverride pro|flash|flash_lite` only with `-NewSession`.

### 5.3 API changes (`dispatch` and `run_job`)
New modes (old `claude` / `codex` / `antigravity` modes keep working for the CLI and old pages):
- `"mode": "task"` — `{ "agent": "claude|antigravity|codex", "role": "architect|backend|frontend|reviewer|tester", "model", "effort", "new_session": false, "project_path", "prompt" }` (prompt required).
- `"mode": "team"` — `{ "agent": "<leader>", "team": { "backend": "<agent>", "frontend": "<agent>", "reviewer": "<agent>" }, "model", "effort", "new_session": false, "project_path", "prompt" }` (prompt required; role is implicitly `leader`).
- Both build `& '<scripts>\invoke-agent.ps1' -Agent ... -Role ... -WorkDir ... [-Team ...] -PromptFile <job prompt file>`.
- `GET status` adds `"api_version": "2.2"` and `"features": ["agents"]` so the page can detect support.
- Job meta / `status.jobs[]` / `job_status` add `agent` (and `team` for team jobs).
