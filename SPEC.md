# Project Specification (`SPEC.md`): Multi-AI Mission Control Dashboard

## 1. Architecture & Tech Stack
- **Backend Runtime**: PHP 8.x (`dashboard/api.php`) served via Laragon (`http://localhost/multi-ai-workflow/dashboard/`).
- **Data Sources (Zero-DB File-Based Telemetry)**:
  - `~/.gemini/antigravity/agentapi-bridge.json`: Live Antigravity Language Server port, CSRF status, and version.
  - `~/.gemini/antigravity/presence/*.lock` & `~/.gemini/antigravity/brain/*`: Active and recent Antigravity conversations & turn status from `transcript.jsonl`.
  - `~/.gemini/antigravity/multi-ai-audit.jsonl`: Real-time audit log of Claude Opus/Sonnet/Haiku and OpenAI Codex invocations, prompt sizes, scores (`X/10`), and verdicts (`APPROVED` / `CHANGES_REQUESTED`).
  - `C:\laragon\www\*`: Local workspace projects discovery (checks for `.git` and `SPEC.md`).
- **Frontend Stack**: Single-file Modern HTML5 + Tailwind CSS (CDN) + Lucide Icons / Chart.js (`dashboard/index.html`) — **100% authored by Claude Sonnet (`-Role frontend`)**.

---

## 2. Strict File Ownership Matrix (Zero-Conflict Boundary)

| Module / Layer | Owner AI | Allowed File Paths (Strict) | Forbidden Files |
| :--- | :--- | :--- | :--- |
| **Backend Telemetry & Dispatch API** | **Antigravity (`Gemini 4 Argon`)** | `dashboard/api.php`, `SPEC.md` | `dashboard/*.html`, `dashboard/*.css`, `dashboard/*.js` |
| **100% Frontend Mission Control UI** | **Claude Sonnet (`-Role frontend`)** | `dashboard/index.html` | `dashboard/api.php`, `*.ps1` |

---

## 3. API Contract (`dashboard/api.php`)

### 3.1. `GET api.php?action=status`
Returns real-time system health, active Antigravity sessions, discovered projects in `C:\laragon\www`, and audit statistics:
```json
{
  "ok": true,
  "timestamp": "2026-10-24T16:05:00+07:00",
  "user_profile": "C:\\Users\\Admin",
  "bridge": {
    "online": true,
    "ls_address": "localhost:59570",
    "csrf_masked": "80b15d0a...abf6",
    "ls_version": "hub-2.26.0",
    "updated_at": "2026-10-24T15:31:00+07:00"
  },
  "tools": {
    "antigravity": { "installed": true, "model": "Gemini 4 Argon (High)", "command": "/claude-leader" },
    "claude": { "installed": true, "version": "2.1.308", "models": ["Opus 4.6", "Sonnet 4.6", "Haiku 4.5"], "command": "/antigravity" },
    "codex": { "installed": true, "version": "0.163.0", "model": "gpt-6-sol (high)", "command": "$multi-ai-leader" }
  },
  "conversations": [
    {
      "id": "3e164ce1-ef65-434c-ad58-d276a32b3c85",
      "is_active": true,
      "updated_at": "2026-10-24 16:03:32",
      "step_count": 48,
      "last_status": "DONE",
      "last_preview": "Đã tích hợp xong Đỉnh thứ 3..."
    }
  ],
  "projects": [
    {
      "name": "multi-ai-workflow",
      "path": "C:\\laragon\\www\\multi-ai-workflow",
      "has_git": true,
      "has_spec": true,
      "has_gemini_md": true
    }
  ],
  "audit": {
    "total_calls": 4,
    "total_prompt_chars": 9850,
    "estimated_tokens_saved": 60000,
    "by_tool": { "claude": 3, "codex": 1 },
    "by_role": { "architect": 1, "frontend": 1, "reviewer": 1, "ui-tweak": 0, "review-diff": 1 },
    "verdicts": { "APPROVED": 1, "CHANGES_REQUESTED": 0, "COMPLETED": 3 },
    "recent_logs": [
      {
        "Timestamp": "2026-10-24T16:05:00+07:00",
        "Tool": "claude",
        "Role": "frontend",
        "Model": "sonnet",
        "WorkDir": "C:\\laragon\\www\\multi-ai-workflow",
        "PromptChars": 2450,
        "Score": "",
        "Verdict": "COMPLETED"
      }
    ]
  }
}
```

### 3.2. `POST api.php?action=init_spec`
- **Request JSON**: `{ "project_path": "C:\\laragon\\www\\my-project", "project_name": "my-project" }`
- **Behavior**: Validates that `project_path` is inside `C:\laragon\www`, copies `../templates/SPEC.template.md` to `<project_path>/SPEC.md` (if not already present), replacing `<Project / Feature Name>` with `project_name`.
- **Response JSON**: `{ "ok": true, "created": true, "spec_path": "C:\\laragon\\www\\my-project\\SPEC.md", "message": "Created SPEC.md successfully." }`

### 3.3. `POST api.php?action=dispatch`
- **Request JSON**:
  ```json
  {
    "mode": "antigravity" | "claude" | "codex" | "council",
    "role": "architect" | "frontend" | "reviewer" | "ui-tweak" | "send-latest",
    "project_path": "C:\\laragon\\www\\multi-ai-workflow",
    "prompt": "Task description...",
    "execute_antigravity": false
  }
  ```
- **Behavior**: Generates the exact PowerShell command string for the selected orchestration mode. If `mode === "antigravity"` and `execute_antigravity === true`, invokes `invoke-antigravity.ps1 -Action send-latest -NoWait` in the background to send the task directly to the open Antigravity IDE window.
- **Response JSON**: `{ "ok": true, "command": "powershell ...", "dispatched": false, "output": "..." }`

---

## 4. UI Design System Seed (For Claude Sonnet `-Role frontend`)
- **Theme**: Dark Mode "Cyberpunk / AI Command Center" (`#090D16` background, `#111827` / `#1E293B` glassmorphism cards with subtle glowing borders).
- **Brand Colors per AI**:
  - **Antigravity (`Gemini 4 Argon`)**: Electric Blue / Cyan (`#3B82F6` / `#06B6D4`)
  - **Claude Code (`Opus / Sonnet / Haiku`)**: Warm Terracotta / Amber (`#D97757` / `#F59E0B`)
  - **OpenAI Codex (`gpt-6-sol`)**: Emerald Green (`#10B981`)
- **Key Sections in `dashboard/index.html`**:
  1. **Top Header**: Live Bridge Status badge (`localhost:<port>`), Auto-Refresh toggle (every 10s), and "Refresh Now" button.
  2. **3-Way Omni-Directional Triangle Hero**: Interactive visual showing the 3 AI vertices (`/claude-leader`, `/antigravity`, `$multi-ai-leader`), their active versions, and token-saving stats (`~80% Claude Tokens Saved`).
  3. **KPI Summary Cards**: Total AI Calls, Estimated Tokens Saved, Approval Rate (`APPROVED`), and Active Antigravity Sessions.
  4. **Command Dispatcher & 1-Click `SPEC.md` Generator**:
     - Dropdown to pick any local project in `C:\laragon\www\*`.
     - Button to initialize `SPEC.md` in that project (`POST api.php?action=init_spec`).
     - Interactive Command Builder & Dispatcher (`POST api.php?action=dispatch`) with 1-click Copy PowerShell Command AND "Send Directly to Antigravity IDE" button.
  5. **Live Antigravity Sessions & Audit Log Table**:
     - Left panel: Active/Recent Antigravity conversations (`id`, step count, status badge, latest response preview).
     - Right panel: Real-time `multi-ai-audit.jsonl` table (Timestamp, Tool badge, Role, Model, Prompt Chars, Score `X/10`, Verdict badge).
