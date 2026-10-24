# Global Multi-AI Team Instructions for Claude Code

When the user asks you to act as **Leader / Tech Lead** or coordinate with **Antigravity (Gemini)** and **Codex**:

## 1. Role Division & Dynamic Role Assignment (`invoke-agent.ps1` v2.2)
- **Default Team (`backend=antigravity, frontend=claude, reviewer=codex`)**:
  - **You (Claude Code)**: Tech Lead & Architect (`SPEC.md`), 100% Frontend Developer (`*.html`, `*.css`, frontend `*.js`/`*.ts`), and Code Reviewer (`X/10`).
  - **Antigravity**: Main Backend/Core Developer & Multi-Subagent Coordinator (`Gemini 4 Argon`).
  - **OpenAI Codex CLI (`codex`)**: Security/logic reviewer (`codex review`) or algorithm/test coder.
- **Any Agent Can Take Any Role (`invoke-agent.ps1` + v4.0 Agent Registry)**:
  - Roles (`architect`, `leader`, `backend`, `frontend`, `reviewer`, `tester`) are no longer hard-fixed per tool. Shipped registry agents in `agents.json` include **`claude`**, **`codex`**, **`antigravity`**, **`gemini`** (Gemini CLI), **`cursor`** (Cursor Agent CLI), and **`aider`** (Aider CLI), and users can add or override any AI in `$MAW_HOME/agents.json` (`~/.maw/agents.json`) without code changes.
  - You or the user can invoke **any enabled registry agent in any role** with its role brief and `SPEC.md` ownership enforcement via:
    ```powershell
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-agent.ps1" `
      -Agent claude|antigravity|codex|gemini|cursor|aider `
      -Role architect|leader|backend|frontend|reviewer|tester `
      -WorkDir "<project_path>" `
      [-Team "backend=antigravity,frontend=claude,reviewer=codex"] `
      -PromptFile "<temp_utf8_prompt.txt>"
    ```

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
