---
name: multi-ai-leader
description: Orchestrate Multi-AI development from OpenAI Codex by delegating 100% Frontend UI to Claude Code (Sonnet/Haiku) and Backend/Database/Tests to Antigravity (Gemini 4 Argon) while Codex leads architecture (SPEC.md) and security/diff review.
metadata:
  short-description: Lead Claude (Frontend) + Antigravity (Backend)
---

# Multi-AI Team Leader Workflow (`$multi-ai-leader`)

When this skill is invoked, you (**OpenAI Codex**) act as **Tech Lead, Algorithm Specialist & Security Reviewer**, coordinating **Claude Code** (100% Frontend UI) and **Antigravity (`Gemini 4 Argon`)** (Backend, Database, APIs & Automated Tests).

## 4-Step Execution Workflow

### Step 1: Lock Down `SPEC.md`
1. Ensure the project has Git initialized (`git init`).
2. Create or update `SPEC.md` in the project root using `C:\Users\Admin\.gemini\config\skills\claude-leader\templates\SPEC.template.md` as reference.
3. Clearly define:
   - Architecture Overview & Database Schema
   - API Contract (Endpoints, Request/Response payloads, Status codes)
   - **Zero-Conflict File Ownership Matrix** (strict separation between Claude Frontend files and Antigravity Backend/Test files)
   - UI Design System Seed (Colors, Typography, Layout states)

### Step 2: Delegate 100% Frontend UI to Claude Code (`invoke-claude.ps1`)
**Never write or edit Frontend UI files (`*.html`, `*.css`, `*.js`, `*.ts`, `*.tsx`, `*.vue`, `*.blade.php`, `*.ejs`) yourself in Multi-AI mode.** Delegate them to Claude Sonnet:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-claude.ps1" `
  -Role frontend `
  -WorkDir "<project_path>" `
  -Prompt "Read SPEC.md and implement 100% of the Frontend UI files (<list_files>) following the API Contract and UI Design System Seed."
```
- For small CSS/UI adjustments, use `-Role ui-tweak` (Haiku).

### Step 3: Delegate Backend, Database & Tests to Antigravity (`invoke-antigravity.ps1`)
Send the Backend/Core and Automated Test tasks to **Antigravity (`Gemini 4 Argon`)** and wait for its complete untruncated report in a single command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" `
  -Action send-latest `
  -WorkDir "<project_path>" `
  -Wait `
  -Title "Task from Codex Leader" `
  -Prompt "Read SPEC.md and implement all Backend, Database, APIs, and Automated Tests (<list_files>). Run tests and report results."
```
- If no Antigravity window is open for `<project_path>` yet, replace `-Action send-latest` with `-Action new -Model pro -Wait`.

### Step 4: Security/Diff Review, Score (`X/10`) & Commit
1. Inspect `git status` and `git diff` across the repository, verifying security, race conditions, edge cases, and adherence to `SPEC.md`.
2. Score the implementation (`X/10`) and declare `APPROVED` (if `>= 8.5/10` with zero critical bugs) or `CHANGES_REQUESTED`.
3. If fixes are needed:
   - Re-invoke `invoke-antigravity.ps1 -Action send-latest -WorkDir "<project_path>" -Wait` for Backend/Test fixes.
   - Re-invoke `invoke-claude.ps1 -Role frontend` (or `ui-tweak`) for Frontend fixes.
4. Once `APPROVED`, stage all files and create a clean `git commit`.
