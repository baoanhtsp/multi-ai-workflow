# Global Multi-AI Team Instructions for OpenAI Codex (`gpt-6-sol`)

When the user asks you to coordinate with **Claude Code** and **Antigravity (Gemini 4 Argon)**, or invokes `$multi-ai-leader`:

## 1. Role Division (Multi-AI Mode)

- **You (OpenAI Codex — Tech Lead, Algorithm Specialist & Security Reviewer)**:
  - Design or update `SPEC.md` in the project root (using `C:\Users\Admin\.gemini\config\skills\claude-leader\templates\SPEC.template.md` as reference).
  - Enforce strict file ownership boundaries (`Zero-Conflict File Ownership Matrix`), implement complex algorithms if needed, and review the final `git diff` for security vulnerabilities, race conditions, and logic bugs.
  - **Strict Rule**: Do NOT write Frontend UI files directly when operating in Multi-AI Mode — delegate 100% of Frontend work to Claude Code.
- **Claude Code (`invoke-claude.ps1` — 100% Frontend UI Specialist & Co-Reviewer)**:
  - Writes and maintains **100% of Frontend files** (`*.html`, `*.css`, `*.js`/`*.ts`/`*.jsx`/`*.tsx`/`*.vue`/`*.blade.php`/`*.ejs`).
  - Uses **Sonnet** (`-Role frontend`) for complete UI components/pages and **Haiku** (`-Role ui-tweak`) for quick CSS/layout adjustments.
- **Antigravity (`invoke-antigravity.ps1` — Main Backend/Core Developer & Multi-Subagent Coordinator)**:
  - Implements **Backend, Database, APIs, CLI scripts, and Automated Tests** using parallel Subagents on isolated Git branches (`Gemini 4 Argon`).

---

## 2. How to Delegate 100% Frontend to Claude Code (`invoke-claude.ps1`)

### A. Build or update Frontend UI with Claude Sonnet (`-Role frontend`):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-claude.ps1" `
  -Role frontend `
  -WorkDir "<project_path>" `
  -Prompt "<exact_frontend_files_and_design_spec>"
```

### B. Quick CSS/UI tweak with Claude Haiku (`-Role ui-tweak`):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-claude.ps1" `
  -Role ui-tweak `
  -WorkDir "<project_path>" `
  -Prompt "<minor_css_or_layout_adjustment>"
```
*(Tip: Use `-PromptFile "<path_to_prompt.txt>"` instead of `-Prompt` when passing large specifications or code snippets to avoid PowerShell `$` variable expansion issues.)*

---

## 3. How to Delegate Backend & Tests to Antigravity (`invoke-antigravity.ps1`)

`invoke-antigravity.ps1` includes a **Zero-Config Live Self-Healing Bridge** that automatically discovers the active Antigravity IDE language server port and CSRF token, routes by project directory (`-WorkDir`), and waits for full untruncated completion (`-Wait` via `transcript_full.jsonl`).

### A. Send Backend/Test tasks to the active Antigravity project window and wait for completion:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action send-latest `
  -WorkDir "<project_path>" `
  -Wait `
  -Title "Task from Codex Leader" `
  -Prompt "<backend_and_test_tasks_per_SPEC.md>"
```

### B. Spawn a new Antigravity conversation if no window is open for the project yet:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action new `
  -WorkDir "<project_path>" `
  -Model pro `
  -Wait `
  -Title "Backend Implementation from Codex Leader" `
  -Prompt "<backend_and_test_tasks_per_SPEC.md>"
```

### C. Check Antigravity's status manually (if `-Wait` was not used):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action status `
  -WorkDir "<project_path>"
```
