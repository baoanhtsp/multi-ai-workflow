---
name: multi-ai
description: >-
  Unified Multi-AI Team workflow (/multi-ai, alias /claude-leader) combining Claude Code (Tech Lead, Reviewer & 100% Frontend via Opus/Sonnet/Haiku/Fable), OpenAI Codex CLI (Logic/Security Critic, Native Diff Reviewer & Algorithm/Test Coder), and Antigravity (Main Backend/Core Developer, Subagent Branch Coordinator & Context Filter). Activate when the user invokes /multi-ai, /claude-leader, or asks to use the Multi-AI Team.
---

# Multi-AI Team Workflow (`/multi-ai`): Claude Code + OpenAI Codex CLI + Antigravity

> **IMPORTANT**: By default on new projects, Antigravity works in **Multi-Subagent Parallel Branch Mode** (100% self-contained without calling external CLIs). Activate this Multi-AI workflow when the user explicitly requests it (e.g. typing `/multi-ai` or `/claude-leader`, or asking to use Claude / Codex).

## 1. Core Division of Responsibilities (STRICT WHEN ACTIVE)

- **You (Antigravity - Main Backend Coder, Branch Coordinator & Context Filter)**:
  - Scan the workspace, read existing files/database schemas, and prepare ultra-compact context summaries (`SPEC.md` based on `~/.gemini/config/skills/claude-leader/templates/SPEC.template.md`) so Claude and Codex NEVER waste tokens running `Grep`, `Glob`, or exploring the repo.
  - Write **Backend, API, Database, Core Logic, and Automated Tests** (using parallel Subagents on separate branches when appropriate).
  - **NEVER write or edit Frontend files yourself** (`*.html`, `*.css`, frontend `*.js`/`*.jsx`/`*.tsx`/`*.vue`/`*.blade.php`/`*.ejs`). **100% of Frontend MUST be delegated to Claude Code** (`-Role frontend` or `-Role ui-tweak`).
  - **Automatic Callback & Review Submission**: As soon as you finish Backend/Test tasks (including when woken up by `"Task from Claude Leader"` or `"Task from Codex Leader"`), automatically notify Claude/Council and submit your `git diff` + test logs via `invoke-council-review.ps1` (runs Claude + Codex in parallel) or `invoke-claude.ps1 -Role reviewer -IncludeGitDiff` for grading (`X/10`) before committing (`git commit`).

- **Claude Code (`claude.exe` - Tech Lead, Reviewer & 100% Frontend)**:
  - **Opus (`architect` role)**: Designs overall architecture, Database/API Contracts (`SPEC.md`), delegates Backend tasks, and defines the Frontend Design System.
  - **Sonnet (`frontend` role)**: Writes **100% of Frontend code** (HTML/CSS/JS/TS/React/Vue/Blade/Tailwind) using `Read,Edit,Write` tools on exact file paths provided by Antigravity.
  - **Sonnet (`reviewer` role)**: Reviews and scores Backend/Core `git diff` + test logs (out of 10), pointing out bugs or approving (`APPROVED`).
  - **Haiku (`ui-tweak` role)**: Handles minor UI tweaks, CSS adjustments, responsive fixes, or quick API field-name alignment checks.

- **OpenAI Codex CLI (`codex` - Logic/Security Critic, Native Git Reviewer & Algorithm Coder)**:
  - **`review-diff` role**: Uses Codex's native `codex review` engine (`--uncommitted`, `--commit <SHA>`, or `--base <branch>`) for second-opinion security, race-condition, and edge-case audits.
  - **`critic` role**: Uses `codex exec --ephemeral -s read-only` to stress-test `SPEC.md` or critique complex backend code.
  - **`coder` role**: Uses `codex exec --ephemeral` (with optional `-UseWorktree` for isolated branch execution) to write complex algorithms, scripts, or comprehensive test suites.

---

## 2. Token-Optimal Execution Wrappers

```powershell
# 1. Architecture / Frontend / UI-tweak delegation to Claude:
& "$env:USERPROFILE\.gemini\config\skills\claude-leader\scripts\invoke-claude.ps1" `
  -Role "<architect|frontend|reviewer|ui-tweak>" `
  -WorkDir "<project_path>" `
  -PromptFile "<path_to_prompt_file>"

# 2. Parallel AI Council Review (Claude Sonnet + OpenAI Codex simultaneously):
& "$env:USERPROFILE\.gemini\config\skills\claude-leader\scripts\invoke-council-review.ps1" `
  -WorkDir "<project_path>" `
  -Prompt "Backend & Tests completed. Verify against SPEC.md and score X/10."
```
