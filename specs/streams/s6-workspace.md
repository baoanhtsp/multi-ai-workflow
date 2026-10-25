# S6 — Agent workspace: 3-column UI, persistent agents, chat, team builder, handoffs, memory, palette

Owns: `server/features/{agents-ws,teams,chat,handoffs,memory}/**`, `scripts/hooks/*/60-*.ps1`, `dashboard/feat-{workspace,teams,palette}.*`, `specs/s6-*.md`.
Reference: SPEC §9.4 (V1–V8) and §9.6 (B1, B3, B4, B6, N7, N10, N11). Re-implement; **never copy Maestro code** (AGPL).

## Items
1. **V1 — Workspace view** (a full-screen view registered with `MAW.addView`, which F0 provides; the classic dashboard stays as a second view)
   - Left: groups → agents. Each agent shows its name, platform, a status dot (idle / thinking / waiting / error / needs-login), a git badge and a bookmark. Groups are collapsible; drag an agent between groups.
   - Centre: chat with the selected agent, one tab per conversation, `+` for a new one.
   - Right: Files (S5) / History / Auto Run (S2) tabs. If a feature is not merged yet, show a placeholder.
   - Top bar: agent, branch, `+added −removed`, cost of this conversation, context-window meter.
   - Status line: "<agent> đang suy nghĩ… · đã chạy 1m12s · <task> · Dừng".
   - Desktop first; on mobile, the columns become tabs.
2. **V2 — Persistent agents**
   - `{ id, name, group, platform (registry id), model, effort, workdir, cli_args[], env{}, hooks, retry_policy, bookmark }`. Platform availability uses the registry (`installed`), with a refresh button.
   - CRUD actions; delete = soft delete with undo.
3. **V3 — Multi-turn chat**
   - A turn is a job with `mode: "chat"`, `agent_profile_id`, `conversation_id` and the platform's resume token (Claude `--resume`, Codex `exec resume`, Gemini `--resume`, Antigravity conversation).
   - Conversations are stored as JSONL. Per message you can switch platform / model / effort; a platform switch starts a new session seeded with a summary.
   - **Message queue** while busy ("n mục đang chờ"): text goes into a running Antigravity session through `send-message`; for other platforms it waits for the next turn.
   - Images: allowed as attachments only where the CLI supports them.
4. **V4 + N10 — Team builder**
   - Templates: Full Team (Lead, Deputy, Planner, Worker, Testing, Hacker) and Empty.
   - Shared settings: dir, platform, model, effort, write scope, writable dirs.
   - Per role:
     - name, working style (persistent / per task / new chat per task), persona, may-delegate;
     - responsibility, delegation / reporting, output, permissions;
     - optional override (dir, platform, write scope).
   - Profile library, save / update a template.
   - **Stored in the repo** as `.maw/team.json` + `.maw/roles/*.md` (versioned, import / export, share between projects).
   - "Suggest from scoreboard" calls S4 `suggest_team`.
5. **V5 + B4 + B1 — Handoffs**
   - The Lead can dispatch to members.
   - Each handoff is a record: `{ id, from, to, task, status: started|running|completed|failed|blocked, result }` with a **structured result** `{ status, summary, files_changed[], evidence, blockers[], cost }` (validated JSON; a member must end with a fenced `json` block, and on parse failure the handoff is marked `needs_review`).
   - Members run **isolated** (S1 `isolate: true`) and their write scope is checked by SPEC Guard.
   - Results return into the Lead's conversation as a compact summary.
   - "ĐANG CHỜ (n)" panel; toast + `handoff-done` event (S3 inbox).
   - The Lead's final summary table is rendered from the records, not typed by the model.
6. **B3 — Readiness**: "Kiểm tra sẵn sàng" uses S3 `health_check` (free, ~1 s) instead of asking the models. It records the **actual model** reported by each CLI per turn.
7. **B6 — Context compaction**: track context use per conversation (from CLI usage data, or estimated). Past a threshold (default 70 %), the agent writes a summary and the conversation continues in a new session seeded with it. Members only send summaries to the Lead.
8. **N7 — Project memory**
   - `.maw/memory/decisions.md` (ADR-style entries) appended from handoff results and Lead summaries; the user edits / pins entries.
   - Briefs include the relevant entries (pinned + keyword match, size-capped).
9. **V8 — Agent context menu**: rename, edit, role setup, duplicate, bookmark, move to group, git log / diff / pull / push / switch branch / create PR (S1 / S2 APIs; hidden if not available), configure worktree, copy agent id, delete. Deleting a group moves its agents out.
10. **N11 — Command palette (Ctrl+K everywhere)**: actions, agents, conversations, projects, templates and tasks, with fuzzy search. It replaces the project-only Ctrl+K; keep project switching as one of its sources. Coordinate with the Tech Lead through "Requests".
