# S5 — Review: diff review UI, files panel, steer

Owns: `server/features/{review,files,steer}/**`, `dashboard/feat-{review,files,steer}.*`, `specs/s5-*.md`.

## Items
1. **N4 / #8 — Diff review UI**
   - Diff for:
     - the working tree;
     - a branch vs its base (S1 worktrees);
     - a job (checkpoint before → after, from S1);
     - a commit.
   - In-house renderer (no CDN): file list with +/− counts, unified and split view, syntax-light colouring, collapse unchanged lines, large-file guard.
   - **Accept / reject per file and per hunk**: reject = reverse-apply the hunk (`git apply -R` on a generated patch) with confirmation and a checkpoint first.
   - **Inline comments** on lines. "Gửi góp ý cho agent" turns all comments into a fix prompt (file:line + quote + comment) and starts a fix job for the same agent / branch, or queues an S2 card.
   - A review verdict field (APPROVED / CHANGES_REQUESTED + score) is stored with the job, so it counts in the S4 scoreboard.
2. **V9 — Files panel** (used by the S6 workspace right column):
   - project tree with git status dots, lazy loading;
   - hide / show dotfiles, search by name;
   - open a file read-only with line numbers (size limit) and "open in editor" (the configured editor command, argument array);
   - a history tab showing recent commits that touched the selected file.
3. **#10 — Steer** (replaces interactive terminals, SPEC §9.2):
   - send a follow-up to a **running** Antigravity job (`send-message` to its conversation id);
   - for the other platforms, queue the message as the next turn;
   - **continue** a finished job with the same agent session using the registry `cli.resume_args` (Claude `--resume <id>`, Codex `exec resume <id>`, Gemini `--resume <id>`). The Tech Lead adds `resume_args` to the registry; until then, use built-in defaults and document them.
   - Show the steer history inside the job log.
