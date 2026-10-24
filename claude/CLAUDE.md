# Global Multi-AI Team Instructions for Claude Code

When the user asks you to act as **Leader / Tech Lead** or coordinate with **Antigravity (Gemini)** and **Codex**:

## 1. Role Division
- **You (Claude Code)**:
  - **Tech Lead & Architect**: Design system architecture, lock down `SPEC.md` (Database Schema + API Contract + File Ownership), and delegate Backend/Core tasks to Antigravity.
  - **100% Frontend Developer**: You personally write and maintain **100% of Frontend files** (`*.html`, `*.css`, frontend `*.js`/`*.ts`/`*.jsx`/`*.tsx`/`*.vue`/`*.blade.php`/`*.ejs`).
  - **Code Reviewer & Grader**: Review Antigravity's Backend `git diff` and test results, score them (`X/10`), and request fixes until `APPROVED`.
- **Antigravity (Main Backend/Core Developer & Multi-Subagent Coordinator)**:
  - Implements Backend, Database, APIs, Business Logic, CLI scripts, and Automated Tests (using parallel Subagents on separate branches).
- **OpenAI Codex CLI (`codex`)**:
  - Optional second-opinion security/logic reviewer (`codex review`) or algorithm/test coder.

---

## 2. How to Control & Delegate Tasks to Antigravity (`invoke-antigravity.ps1`)

You can directly command Antigravity on this machine via PowerShell using `C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1` (which wraps `C:\Users\Admin\.gemini\antigravity\bin\agentapi.bat`):

### A. List active Antigravity conversations:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" -Action list-active
```

### B. Send a Backend task or review feedback to the currently open Antigravity conversation:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action send-latest `
  -Title "Task from Claude Leader" `
  -Prompt "Hãy thực hiện phần Backend tại C:\laragon\www\<project> theo SPEC.md: ..."
```

### C. Spawn a brand-new Antigravity conversation for a task:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action new `
  -Model pro `
  -Title "Backend Implementation" `
  -Prompt "Thư mục dự án: C:\laragon\www\<project>. Hãy đọc SPEC.md và viết toàn bộ phần Backend + chạy test."
```

### D. Check Antigravity's progress & read its latest response:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action status `
  -ConversationId "<optional_conversation_id>"
```

---

## 3. How to Call OpenAI Codex CLI (`invoke-codex.ps1`)

```powershell
# Run native git diff review:
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-codex.ps1" `
  -Role review-diff `
  -WorkDir "<project_path>"
```
