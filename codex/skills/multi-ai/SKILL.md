---
name: multi-ai
description: Unified Multi-AI Team workflow ($multi-ai, alias $multi-ai-leader). Orchestrate Multi-AI development from OpenAI Codex by delegating 100% Frontend UI to Claude Code (Sonnet/Haiku) and Backend/Database/Tests to Antigravity (Gemini 4 Argon) while Codex leads architecture (SPEC.md) and security/diff review.
metadata:
  short-description: Lead Claude (Frontend) + Antigravity (Backend)
---

# Multi-AI Team Workflow (`$multi-ai`)

When this skill is invoked, you (**OpenAI Codex**) act as **Tech Lead, Algorithm Specialist & Security Reviewer**, coordinating **Claude Code** (100% Frontend UI) and **Antigravity (`Gemini 4 Argon`)** (Backend, Database, APIs & Automated Tests).

> **CRITICAL RULE (NO MANUAL POLLING BY USER)**:
> - **NEVER** stop your turn and tell the user *"Mình không tự theo dõi Antigravity trong nền được. Khi bạn thấy Antigravity báo xong, nhắn mình một câu..."*!
> - `invoke-antigravity.ps1` **automatically blocks and waits by default** until Antigravity finishes its turn and prints the full untruncated response right back to your terminal.
> - Always run `invoke-antigravity.ps1` synchronously (never as a detached background task). If a command ever times out while Antigravity is still coding, **immediately call `invoke-antigravity.ps1 -Action wait -WorkDir "<project_path>"` yourself** until Antigravity completes, then immediately review `git diff`!

## 4-Step Execution Workflow

### Step 1: Lock Down `SPEC.md`
1. Ensure the project has Git initialized (`git init`).
2. Create or update `SPEC.md` in the project root using `C:\Users\Admin\.gemini\config\skills\claude-leader\templates\SPEC.template.md` as reference.

### Step 2: Delegate 100% Frontend UI to Claude Code (`invoke-claude.ps1`)
**Never write or edit Frontend UI files (`*.html`, `*.css`, `*.js`, `*.ts`, `*.tsx`, `*.vue`, `*.blade.php`, `*.ejs`) yourself in Multi-AI mode.** Delegate them to Claude Sonnet:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-claude.ps1" `
  -Role frontend `
  -WorkDir "<project_path>" `
  -Prompt "Read SPEC.md and implement 100% of the Frontend UI files (<list_files>) following the API Contract and UI Design System Seed."
```

### Step 3: Delegate Backend, Database & Tests to Antigravity (`invoke-antigravity.ps1`)
Send the Backend/Core and Automated Test tasks to **Antigravity (`Gemini 4 Argon`)** (auto-waits for completion by default):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action send-latest `
  -WorkDir "<project_path>" `
  -Title "Task from Codex Leader" `
  -Prompt "Read SPEC.md and implement all Backend, Database, APIs, and Automated Tests (<list_files>). Run tests and report results."
```

### Step 4: Security/Diff Review, Score (`X/10`) & Commit
1. Immediately after `invoke-antigravity.ps1` returns Antigravity's completion report, inspect `git status` and `git diff` across the repository, verifying security, race conditions, edge cases, and adherence to `SPEC.md`.
2. Score the implementation (`X/10`) and declare `APPROVED` (if `>= 8.5/10` with zero critical bugs) or `CHANGES_REQUESTED`.
