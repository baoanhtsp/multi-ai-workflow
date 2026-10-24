# Project Specification (`SPEC.md`): Multi-AI Mission Control Dashboard (v2.0)

## 1. Architecture & Tech Stack
- **Backend Runtime**: PHP 8.x (`dashboard/api.php`) served via Laragon (`http://multi-ai-workflow.test/dashboard/`).
- **PowerShell Orchestration Suite (`antigravity/skills/claude-leader/scripts/`)**:
  - `invoke-claude.ps1`: Claude Opus / Sonnet / Haiku / Fable wrapper with token/cost telemetry.
  - `invoke-codex.ps1`: OpenAI Codex CLI (`GPT-6.1-Sol`, `GPT-6-Astra`, `GPT-6-Sol`) wrapper with token/cost telemetry.
  - `invoke-antigravity.ps1`: Zero-Config Live Self-Healing Bridge to Antigravity IDE (`Gemini 4 Argon`).
  - `invoke-council-review.ps1`: Parallel Dual-AI Review (Claude Sonnet + OpenAI Codex simultaneously).
  - `invoke-spec-guard.ps1`: 0-Token Static `SPEC.md` Contract & File Ownership Boundary Guard.
  - `invoke-auto-gate.ps1`: Automated Bounded Loop (`Implement -> SPEC Guard -> Council Review -> Auto-Fix`).
  - `send-notification.ps1`: Native Windows 10/11 Toast Notification + Webhook (Discord/Slack) + Telegram Bot pusher.
- **Frontend Stack**: Single-file Bilingual (`🇻🇳 VI | 🇬🇧 EN`) Modern HTML5 + Tailwind CSS + Lucide Icons (`dashboard/index.html`) — **100% authored by Claude Sonnet (`-Role frontend`)**.

---

## 2. Strict File Ownership Matrix (Zero-Conflict Boundary)

| Module / Layer | Owner AI | Allowed File Paths (Strict) | Forbidden Files |
| :--- | :--- | :--- | :--- |
| **Backend API & PowerShell Scripts** | **Antigravity (`Gemini 4 Argon`)** | `dashboard/api.php`, `SPEC.md`, `*.ps1` | `dashboard/*.html`, `dashboard/*.css`, `dashboard/*.js` |
| **100% Frontend Mission Control UI** | **Claude Sonnet (`-Role frontend`)** | `dashboard/index.html` | `dashboard/api.php`, `*.ps1` |

---

## 3. API Contract (`dashboard/api.php` v2.0)

### 3.1. `GET api.php?action=status`
Returns real-time system health, active Antigravity sessions, discovered projects in `C:\laragon\www`, Git info for the primary project, notification settings, recent background jobs, and real token/cost audit statistics (`total_input_tokens`, `total_output_tokens`, `total_cost_usd`, `estimated_cost_saved_usd`, `cost_by_tool`, `cost_by_model`).

### 3.2. `GET api.php?action=git_info&project_path=<path>`
Returns Git status for the selected project (`has_git`, `current_branch`, `modified_count`, `ahead`, `behind`, `branches`, `worktrees`, `recent_commits`).

### 3.3. `POST api.php?action=spec_guard`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\multi-ai-workflow" }`
- **Response JSON**: `{ "ok": true, "verdict": "PASS" | "WARN", "has_spec": true, "total_modified": 0, "frontend_count": 0, "backend_count": 0, "modified_files": [...], "spec_endpoints": [...], "violations": [...] }`

### 3.4. `POST api.php?action=init_spec`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\my-project", "project_name": "my-project" }`
- **Response JSON**: `{ "ok": true, "created": true, "spec_path": "...", "message": "..." }`

### 3.5. `POST api.php?action=dispatch`
- **Request JSON**: `{ "mode": "antigravity"|"claude"|"codex"|"council"|"auto-gate"|"spec-guard", "role": "...", "model": "...", "effort": "...", "project_path": "...", "prompt": "...", "execute_antigravity": false }`
- **Response JSON**: `{ "ok": true, "command": "& '...'", "dispatched": false, "output": "" }`

### 3.6. `POST api.php?action=run_job` (Live Web Job Runner for ALL Modes)
- **Request JSON**: `{ "mode": "antigravity"|"claude"|"codex"|"council"|"auto-gate"|"spec-guard", "role": "...", "model": "...", "effort": "...", "project_path": "...", "prompt": "..." }`
- **Response JSON**: `{ "ok": true, "job_id": "job_20261024_...", "pid": 12345, "status": "RUNNING", "command": "& '...'" }`

### 3.7. `GET api.php?action=job_status&job_id=<id>&offset=<bytes>`
- **Response JSON**: `{ "ok": true, "job_id": "...", "status": "RUNNING"|"DONE"|"FAILED"|"CANCELLED", "pid": 12345, "elapsed_sec": 8, "log_chunk": "...", "next_offset": 512, "full_log_size": 512 }`

### 3.8. `POST api.php?action=cancel_job`
- **Request JSON**: `{ "job_id": "job_20261024_..." }`
- **Response JSON**: `{ "ok": true, "job_id": "...", "status": "CANCELLED" }`

### 3.9. `POST api.php?action=save_notify` & `POST api.php?action=test_notify`
- Saves/tests Windows Desktop Toast, Discord/Slack Webhook URL, and Telegram Bot notifications.
