# S2 — Board: kanban with dependencies, retry, presets, Auto Run, schedules, GitHub

Owns: `server/features/{tasks,github,schedules,playbooks}/**`, `scripts/hooks/*/20-task*.ps1`, `dashboard/feat-{tasks,github}.*`, `specs/s2-*.md`.

## Items
1. **N1 / #4 — Task board**
   - Cards: `{ id, title, prompt, project_path, agent, role, mode (task|team|council|auto-gate|chat), depends_on[], priority, status: backlog|queued|running|needs_input|review|done|failed, job_id?, attempts[], created_by (user|lead|github|playbook|schedule) }`. Stored in `$MAW_HOME/data/tasks/`.
   - Scheduler (in the server process, idempotent after a restart):
     - starts queued cards whose dependencies are `done`;
     - respects concurrency limits per platform / agent (registry ids) and globally;
     - maps job results back to card status.
   - Actions: `task_list|create|update|delete|move|start|cancel`.
   - UI: kanban with drag between columns, dependency arrows / badges, filters per project / agent.
2. **#5 — Retry / reassign / resume**: one click re-runs a failed or rejected card with the same prompt plus the reviewer findings, on the same or a different agent. Optional auto-retry with exponential backoff and `max_attempts`. The attempts history is kept on the card.
3. **#6 — Templates + team presets**
   - Prompt templates with variables (`{{feature}}`, `{{file}}`).
   - Presets = role → agent assignment, max fix rounds, budget, isolate on/off.
   - Import / export as JSON; read-only built-ins plus user ones.
4. **V10 — Auto Run playbooks**
   - A markdown checklist file (`.maw/playbooks/*.md` or any path inside the project) becomes cards in order, each run in a fresh session.
   - The box is ticked in the file when its card is done.
   - Stop on the first failure, or continue (option).
5. **N9 — Scheduled runs**
   - A cron-like schedule (`daily HH:MM`, `weekly <day> HH:MM`, `every N minutes`) creates cards / starts flows (e.g. nightly Council review of uncommitted work, weekly security audit).
   - Runs only while the server is running; a run missed during downtime is caught up once at start.
6. **N13 — GitHub via `gh`** (argument arrays; if `gh` is missing or not logged in, say so and disable):
   - import an issue → card (title / body / labels);
   - on approval, push the branch (S1 worktree branch) and open a PR with an AI-written description (a job with the reviewer role summarising the diff);
   - import PR review comments / failed checks → a fix card.

## Contracts with other streams
- Start work only through `ctx.startJob` (SPEC §9.0). For isolation pass `isolate: true` (S1).
- Expose `task_create` so S3 (Telegram), S6 (Lead plans) and schedules can add cards.
