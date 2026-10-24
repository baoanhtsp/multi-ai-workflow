---
name: claude-leader
description: >-
  On-demand multi-AI team workflow combining Claude Code (Tech Lead, Reviewer & 100% Frontend via Opus/Sonnet/Haiku), OpenAI Codex CLI (Logic/Security Critic, Native Diff Reviewer & Algorithm/Test Coder), and Antigravity (Main Backend/Core Developer, Subagent Branch Coordinator & Context Filter). Activate when the user invokes /claude-leader or asks to use Claude or Codex.
---

# Multi-AI Team Workflow: Claude Code + OpenAI Codex CLI + Antigravity

> **IMPORTANT**: By default on new projects, Antigravity works in **Multi-Subagent Parallel Branch Mode** (100% self-contained without calling external CLIs). Activate this external Multi-AI workflow when the user explicitly requests it (e.g. typing `/claude-leader`, asking for Claude Leader / Claude Frontend, or asking to use Codex CLI).

## 1. Core Division of Responsibilities (STRICT WHEN ACTIVE)

- **You (Antigravity - Main Backend Coder, Branch Coordinator & Context Filter)**:
  - Scan the workspace, read existing files/database schemas, and prepare ultra-compact context summaries (`SPEC.md`) so Claude and Codex NEVER waste tokens running `Grep`, `Glob`, or exploring the repo.
  - Write **Backend, API, Database, Core Logic, and Automated Tests** (using parallel Subagents on separate branches when appropriate).
  - **NEVER write or edit Frontend files yourself** (`*.html`, `*.css`, frontend `*.js`/`*.jsx`/`*.tsx`/`*.vue`/`*.blade.php`/`*.ejs`). **100% of Frontend MUST be delegated to Claude Code** (`-Role frontend` or `-Role ui-tweak`).
  - Merge branches, run tests, and submit diffs to Claude (`-Role reviewer`) and/or Codex (`-Role review-diff` / `-Role critic`) for grading and bug hunting before committing (`git commit`).

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

### A. Calling Claude Code ([invoke-claude.ps1](./scripts/invoke-claude.ps1))

```powershell
& "$env:USERPROFILE\.gemini\config\skills\claude-leader\scripts\invoke-claude.ps1" `
  -Role "<architect|frontend|reviewer|ui-tweak>" `
  -WorkDir "<project_path>" `
  -Prompt "<compact_prompt_with_precollected_context>"
```

### B. Calling OpenAI Codex CLI ([invoke-codex.ps1](./scripts/invoke-codex.ps1))

```powershell
# 1. Review uncommitted git diff or a specific commit:
& "$env:USERPROFILE\.gemini\config\skills\claude-leader\scripts\invoke-codex.ps1" `
  -Role "review-diff" `
  -WorkDir "<project_path>" `
  -CommitSha "<optional_sha>"

# 2. Read-only architectural or security critique:
& "$env:USERPROFILE\.gemini\config\skills\claude-leader\scripts\invoke-codex.ps1" `
  -Role "critic" `
  -WorkDir "<project_path>" `
  -Prompt "<compact_prompt_with_code_or_spec>"

# 3. Write code or tests (optionally in an isolated Git worktree):
& "$env:USERPROFILE\.gemini\config\skills\claude-leader\scripts\invoke-codex.ps1" `
  -Role "coder" `
  -WorkDir "<project_path>" `
  -UseWorktree `
  -Prompt "<scoped_coding_task>"
```

---

## 3. Step-by-Step Standard Loop (Spec-Driven + Bounded Review)

1. **Pre-Filter Context & Lock `SPEC.md` (Antigravity + Opus)**:
   - Extract essential repo context and call `invoke-claude.ps1 -Role architect` to lock down API Contracts, schemas, and file boundaries in `SPEC.md`.
2. **Parallel Implementation by File Boundaries**:
   - **Backend/Core**: Antigravity (or parallel Subagents / Codex `-Role coder`) implements Backend/API/DB/Tests on isolated branches.
   - **100% Frontend**: Claude (`invoke-claude.ps1 -Role frontend` or `ui-tweak`) implements all UI/Frontend files.
3. **Bounded Review Loop (Max 2 Rounds)**:
   - Run automated tests first.
   - Submit `git diff` + test logs to Claude (`invoke-claude.ps1 -Role reviewer`) and/or Codex (`invoke-codex.ps1 -Role review-diff` / `critic`).
   - Fix all blocking findings until `APPROVED`, then merge branches and `git commit`.
