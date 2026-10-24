# Global Multi-AI Team Instructions for OpenAI Codex (`gpt-6-sol`)

When the user asks you to coordinate with **Claude Code** and **Antigravity (Gemini 4 Argon)**, or invokes `$multi-ai-leader`:

## 1. Role Division & Unified `invoke-agent.ps1` Dispatcher (v2.2)

- **Default Team (`backend=antigravity, frontend=claude, reviewer=codex`)**:
  - **You (OpenAI Codex)**: Tech Lead, Algorithm Specialist & Security Reviewer (`SPEC.md` + `git diff` review).
  - **Claude Code (`invoke-claude.ps1`)**: 100% Frontend UI Specialist (`*.html`, `*.css`, `*.js`/`*.ts`) & Co-Reviewer.
  - **Antigravity (`invoke-antigravity.ps1`)**: Main Backend/Core Developer & Multi-Subagent Coordinator (`Gemini 4 Argon`).
- **Any Agent Can Take Any Role (`invoke-agent.ps1`)**:
  - Roles (`architect`, `leader`, `backend`, `frontend`, `reviewer`, `tester`) are no longer fixed per tool. Use the unified entry point to run any agent in any role with its role brief and `SPEC.md` ownership rules:
    ```powershell
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-agent.ps1" `
      -Agent claude|antigravity|codex `
      -Role architect|leader|backend|frontend|reviewer|tester `
      -WorkDir "<project_path>" `
      [-Team "backend=antigravity,frontend=claude,reviewer=codex"] `
      -PromptFile "<temp_utf8_prompt.txt>"
    ```

---

## 2. CRITICAL RULE: Never Ask the User to Watch Antigravity Manually!

> **STRICT PROHIBITION**:
> - **NEVER** tell the user *"Mình không tự theo dõi Antigravity trong nền được. Khi bạn thấy Antigravity báo xong, nhắn mình một câu..."*!
> - `invoke-antigravity.ps1` **AUTOMATICALLY WAITS BY DEFAULT** (polls `transcript.jsonl` every 2 seconds up to 600s and prints Antigravity's complete untruncated response directly to your terminal output).
> - Never run `invoke-antigravity.ps1` as a detached background job and stop your turn. Run it synchronously and wait for its output.
> - If a long task ever hits a command timeout while Antigravity is still working, **immediately run `invoke-antigravity.ps1 -Action wait -WorkDir "<project_path>"` yourself** in the next step until Antigravity's completed `[Step ...]:` response appears, then immediately review `git diff`!

---

## 3. How to Delegate 100% Frontend to Claude Code (`invoke-claude.ps1`)

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

## 4. How to Delegate Backend & Tests to Antigravity (`invoke-antigravity.ps1`)

### A. Send Backend/Test tasks to Antigravity (Auto-Waits for Completion by Default):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action send-latest `
  -WorkDir "<project_path>" `
  -Title "Task from Codex Leader" `
  -Prompt "<backend_and_test_tasks_per_SPEC.md>"
```

### B. Continue waiting if a massive Backend task exceeded shell timeout:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action wait `
  -WorkDir "<project_path>"
```

### C. Spawn a new Antigravity conversation if no window is open for the project yet:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action new `
  -WorkDir "<project_path>" `
  -Model pro `
  -Title "Backend Implementation from Codex Leader" `
  -Prompt "<backend_and_test_tasks_per_SPEC.md>"
```
