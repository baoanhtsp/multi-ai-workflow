# S4 — Cost & quality: budgets, fallback, auto-recovery, test gate, scoreboard, policies

Owns: `server/features/{budget,fallback,checks,scoreboard,policy}/**`, `scripts/hooks/*/40-*.ps1`, `dashboard/feat-{budget,checks,scoreboard,policy}.*`, `specs/s4-*.md`.

## Items (A items first)
1. **B5 — Budgets**
   - Caps per job, per team run, per day and per project (USD and / or tokens), each with a **warn** and a **block** threshold. The data comes from the audit log.
   - The `before-agent` hook blocks when a cap would be exceeded (reason + inbox entry through the S3 event / API).
   - UI: budget settings plus a spend-vs-cap bar per project and per day.
2. **B2 (fallback part) + V6 — Fallback routing and auto-recovery**
   - Per role, an ordered fallback list of registry agents (e.g. backend: antigravity → codex → gemini).
   - When an agent is unhealthy (S3 `health_check`), rate-limited, or over budget, the `before-agent` hook blocks it and returns the suggested fallback. The job runner, through `ctx`, retries on the next agent automatically **if** the user enabled auto-fallback for that role; otherwise the inbox asks.
   - **Auto-recovery**: detect transient API errors in the log (`429`, `529`, `overloaded`, `rate limit`, `quota`, `usage limit reached … resets at …`):
     - transient errors → retry with backoff 30 s → 30 min (configurable);
     - a token / usage limit with a reset time → wait until the reset, then continue.
   - Show "đang chờ hồi phục (đến 14:05)" in the job header.
3. **B8 — Test gate + Checks panel**
   - Per-project `checks` config (`.maw/checks.json`: commands such as `npm test`, `npm run typecheck`, `phpunit`, each with a timeout), run with argument arrays in the job's worktree.
   - The `before-review` hook (Auto-Gate) and the S6 handoff merge both require a green gate.
   - Checks panel per project / branch: git clean, tests, SPEC Guard, last review score, open TODO markers. "Merge" (S1) is blocked while something is red, with an explicit override.
4. **N3 — Agent scoreboard + auto-assign**
   - Aggregated from the audit plus job metas, per agent × role: approval rate, average score, average fix rounds, cost per approved task, median duration, failure rate.
   - UI table with sorting.
   - Action `suggest_team { project_path? }` returns the best agent per role (ties broken by cost) for the S6 team builder.
5. **N6 — Policies per role**
   - Protected paths (never writable).
   - Command deny / allow patterns (e.g. Hacker: no `git push`, no `rm -rf`; everybody: no `git push --force` without approval).
   - Secret redaction in logs and prompts (tokens, keys, `.env` values).
   - Dangerous commands need approval (→ inbox).
   - Enforcement:
     - in briefs (prepended rules);
     - in the `before-agent` hook (block by role);
     - post-hoc in the job log / diff scan, flagging violations in the review.
   - Platform sandbox flags are used where a CLI supports them (document per platform).
