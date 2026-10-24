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

## 2. CRITICAL RULE: Automatic Blocking Wait & Zero Manual Polling by User

> **STRICT PROHIBITION**:
> - **NEVER** tell the user *"Mình không tự theo dõi Antigravity trong nền được. Khi bạn thấy Antigravity báo xong, nhắn mình một câu..."*!
> - `invoke-antigravity.ps1` **AUTOMATICALLY WAITS BY DEFAULT** (polls `transcript.jsonl` every 2 seconds up to 600s and returns Antigravity's full untruncated response from `transcript_full.jsonl` directly into your Bash tool output).
> - Always set your Bash tool `timeout` to `600000` (10 minutes) when calling `invoke-antigravity.ps1`.
> - If a command ever times out while Antigravity is still coding/testing, you **MUST immediately call `invoke-antigravity.ps1 -Action wait -WorkDir "<project_path>"`** in your very next tool call until Antigravity's final `[Step ...]:` response is returned, and then **immediately proceed to review `git diff` yourself without stopping to ask the user**!

---

## 3. How to Control & Delegate Tasks to Antigravity (`invoke-antigravity.ps1`)

You can directly command Antigravity on this machine via PowerShell using `C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1`:

### A. Send a Backend task or review feedback to Antigravity (Auto-Waits for Completion by Default):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action send-latest `
  -WorkDir "C:\laragon\www\<project>" `
  -Title "Task from Claude Leader" `
  -Prompt "Hãy thực hiện phần Backend tại C:\laragon\www\<project> theo SPEC.md: ..."
```
*(Note: Waiting for completion is enabled by default! If a long task exceeds your shell timeout, immediately run `-Action wait -WorkDir "C:\laragon\www\<project>"` to continue waiting until Antigravity finishes.)*

### B. Continue waiting if Antigravity is still working on a large task:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action wait `
  -WorkDir "C:\laragon\www\<project>"
```

### C. Spawn a brand-new Antigravity conversation for a task (Auto-Waits by Default):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action new `
  -WorkDir "C:\laragon\www\<project>" `
  -Model pro `
  -Title "Backend Implementation" `
  -Prompt "Thư mục dự án: C:\laragon\www\<project>. Hãy đọc SPEC.md và viết toàn bộ phần Backend + chạy test."
```

### D. Check Antigravity's latest response or list active windows:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action status `
  -WorkDir "C:\laragon\www\<project>"
```

---

## 4. How to Call OpenAI Codex CLI (`invoke-codex.ps1`)

```powershell
# Run native git diff review:
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-codex.ps1" `
  -Role review-diff `
  -WorkDir "<project_path>"
```
