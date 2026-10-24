# S3 — Attention: health & readiness, re-login, inbox, Telegram, timeline, doctor, MCP

Owns: `server/features/{health,inbox,telegram,timeline,mcp}/**`, `server/mcp/**`, `scripts/hooks/*/30-*.ps1`, `dashboard/feat-{health,inbox,timeline,mcp}.*`, `specs/s3-*.md`.

## Items (A items first)
1. **B2 + B3 — Pre-flight health check / free readiness**
   - For every registry agent: installed, version, **logged in** and quota / rate-limit hints, using cheap CLI probes that spend **no LLM tokens**. Examples: `claude auth status`-like commands where they exist; `codex login status`; for Gemini, check the configured auth (settings / `GEMINI_API_KEY`); for Antigravity, the bridge plus the hub. Verify each probe against the installed CLI version and document it.
   - Cached for 60 s.
   - Action `health_check { agents? }`.
   - A hook at `before-agent` blocks a dispatch to an unhealthy agent with a clear reason. S4 then suggests the fallback.
   - A "Team readiness" button checks every member of a team in about a second and shows a table (agent, platform, actual model, status, reason).
2. **V7 — Re-login flow**
   - An auth error in a job log (patterns per platform, e.g. `OAuth session expired`, `Please set an Auth method`, `401`) marks the job `needs_login`.
   - The UI shows a card with "Đăng nhập lại" and "Thử lại".
   - "Đăng nhập lại" opens a **real terminal window** (`Start-Process powershell -ArgumentList '-NoExit','-Command', '<login cmd>'` with an argument array) running the platform's login command from the registry (`login_cmd`, e.g. `claude /login`, `codex login`, `gemini`). The Tech Lead adds the registry field if missing; until then, use the built-in defaults.
   - "Thử lại" re-runs the job.
3. **N5 — Attention inbox**: one list of everything waiting for the user — jobs `needs_input` / `needs_login`, failed jobs, reviews `CHANGES_REQUESTED` after the max rounds, budget blocks (S4), finished handoffs (S6 `handoff-done`). Each entry has quick actions (open, retry, approve, dismiss) and a header badge with the count. It also replaces ad-hoc toasts.
4. **N5 — Two-way Telegram**
   - Long-poll `getUpdates` with the configured bot (server-side, only for the configured `chat_id`, ignore everyone else).
   - Commands: `/status`, `/inbox`, `/approve <id>`, `/retry <id>`, `/stop <id>`, a reply to a notification = answer / follow-up, `/task <text>` → S2 `task_create`.
   - A morning / evening digest is optional.
   - The bot token is never logged.
5. **N8 — Timeline + report**: a Gantt of a team run or of any time window (jobs / handoffs per agent lane, colour by status, cost tooltip). Export an HTML or Markdown report (summary, per-agent results, costs, review scores, files changed).
6. **N12 — Doctor in the UI**: the `doctor.ps1` information as a panel (install / login / version / update available per platform; scripts installed; hooks), with "open login terminal" and "copy install command".
7. **N14 — MCP**
   - (a) **Config manager**: read / write the MCP server list of each platform's config (Claude `~/.claude.json` `mcpServers`, Codex `~/.codex/config.toml` `[mcp_servers]`, Gemini `~/.gemini/settings.json` `mcpServers`). Show a diff before writing, keep a backup, and "apply this server to all agents".
   - (b) **The dashboard as an MCP server**: `node server/mcp/main.ts` (stdio, JSON-RPC, zero dependencies). Tools: `list_agents`, `create_task`, `start_job`, `job_status`, `request_review`, `inbox`. It talks to the running server over HTTP with the `X-MAW-Request` header. Document how to register it in each platform.
