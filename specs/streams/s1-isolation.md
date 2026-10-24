# S1 — Isolation: checkpoints, worktrees, merge, fork, best-of-N

Owns: `server/features/{checkpoints,worktrees}/**`, `scripts/hooks/*/10-checkpoint*.ps1`, `scripts/maw-worktree*.ps1`, `dashboard/feat-{checkpoints,worktrees}.*`, `specs/s1-*.md`.

## Items (build in this order)
1. **B7 / #9 — Checkpoints + one-click rollback**
   - Hooks `job-start`, `round-start` (Auto-Gate) and `before-agent` snapshot the project: `git stash create` including untracked files (or a temporary index commit) stored under `refs/maw/checkpoints/<job>/<n>`. It must work for edits made by bash or by any agent.
   - Actions: `checkpoint_list?project_path=&job_id=`, `checkpoint_diff` (between two checkpoints or a checkpoint and the working tree), `checkpoint_restore` (confirm in the UI; restore takes a safety checkpoint first so it can be undone).
   - UI: a "Checkpoints" timeline tab plus a job action "Rollback to before this job".
   - Retention: keep the last 50 per project (configurable); prune old refs.
2. **B1 / #1 — Worktree + branch per job / handoff, then merge**
   - Action `worktree_create { project_path, base, name? }` creates `../.maw-wt/<project>/<job>` on branch `maw/<job>`.
     - Copy files listed in `.worktreeinclude` (e.g. `.env`).
     - Run an optional per-project setup script `.maw/setup.ps1` with `WORKTREE_PATH` / `REPO_PATH`.
     - Give each worktree its own `MAW_PORT`.
   - Actions: `worktree_list`, `worktree_diff` (vs base), `worktree_merge { strategy: merge|squash|rebase }` with a conflict report (list of files plus a "fix conflicts with agent X" job), `worktree_discard`.
   - Jobs accept `"isolate": true`: the job runs in a fresh worktree, and its meta records `worktree` / `branch`. Members' handoffs in S6 use this.
   - After merge, SPEC Guard runs on the branch diff with the member's owner (multi-owner rules, SPEC §7.4).
3. **#3 — Fork a job**: clone a finished or running job into a new worktree with the same prompt plus the previous result summary, optionally on a different agent.
4. **N2 / #2 — Best-of-N**
   - Action `bestof_start { project_path, prompt, role, candidates: [{agent, model?}] (2–4), judge: "council"|"tests"|"both" }`.
   - Runs every candidate isolated, then the judge (S4 test gate commands and/or Council over each branch diff). Shows a comparison card (score, tests, cost, time, diff size) and lets the user merge the winner.
5. **V8 git actions** for the S6 agent context menu (HTTP only, no UI here beyond a small panel): `git_log`, `git_diff`, `git_pull`, `git_push` (confirm), `git_branch_switch`, `git_branch_create`. Argument arrays only.

## Notes
- Worktrees live **outside** the project folder, so tools in the main checkout never see them.
- Every action validates `project_path` with `resolveProjectPath`, and git refs with a strict regex.
