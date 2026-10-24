# v5 feature streams — common rules (owned by the Tech Lead)

Read `SPEC.md` §7 (agent registry), §9.0 (F0 plugin foundation), §9.1 (ownership), §9.2 (constraints), §9.4–9.6 (video parity + extra items) before anything else. Your stream file (`s1`…`s6`) lists exactly what to build.

## Who does what in a stream
- **You (a Claude session)** are the **stream lead**:
  - write the design `specs/s<n>-design.md` (actions, request/response JSON, data files, hook files, UI);
  - build the **frontend** (`dashboard/feat-*.js|css` of your stream only);
  - review the backend;
  - run the final checks.
- **Backend** goes to **your own Antigravity conversation**, never to a shared one:
  1. Write the backend task to a temp UTF-8 file.
  2. Start it with:
     ```
     powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" -Action new -WorkDir "<your worktree path>" -Title "S<n> backend" -PromptFile <file>
     ```
     It prints `CONVERSATION_ID: <uuid>`. Keep that id and use `-ConversationId <uuid>` for every follow-up (`send` / `wait`).
  3. Bash timeout is 600000 ms. If a call times out while Antigravity is still working, run `-Action wait -ConversationId <uuid>` again. Never ask the user to watch Antigravity.
  4. Tell Antigravity the **absolute worktree path** and that it must only edit files inside it, within your stream's backend paths.
- Review loop: read the `git diff` of your branch, score it X/10, and send fixes until APPROVED (≥ 8.5, at most 3 rounds). Then run a Codex review:
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-codex.ps1" -Role review-diff -WorkDir "<worktree>"
  ```

## Hard rules
- Only touch your stream's paths (SPEC §9.1 / §9.5). Never edit `SPEC.md`, `dashboard/index.html`, `server/http.ts`, the job runner, `invoke-auto-gate.ps1`, `invoke-agent.ps1`, `agents.json` or another stream's files.
- If you need a change in a shared file, write it under **"Requests to Tech Lead"** in your design file and build against the documented hook / API meanwhile.
- Zero runtime dependencies, no CDN scripts, Windows PowerShell 5.1 + Node ≥ 22.18. No string is ever passed to a shell; child processes use argument arrays.
- Every destructive action asks for confirmation in the UI and writes an audit line.
- Commit on your own branch with clear messages. Do not push, do not merge into other branches, do not open PRs.

## Definition of done (every stream)
1. `npm run typecheck`, `npm test`, `Invoke-Pester tests` and `tests/api-smoke.ps1` are green in your worktree. New behaviour has tests.
2. You checked the UI in a browser against a server started from your worktree on a free port: `node server/main.ts --port <free>`. No console errors, and it works in the light, dark and neon themes and at mobile width.
3. The Antigravity backend is APPROVED by you and the Codex review has no unresolved major findings.
4. Your final report lists: the branch, the commits, what was built per item id (B…, N…, V…, #…), the test output, anything not done or deferred, and the "Requests to Tech Lead".
