# Multi-AI Mission Control MCP Server

`server/mcp/main.ts` exposes the Multi-AI Mission Control Dashboard as a standard Model Context Protocol (MCP) server over `stdio` using newline-delimited JSON-RPC 2.0.

Zero runtime dependencies — runs natively with Node.js 22.18+.

---

## 1. Quick Registration for Agents

### 1. Claude Code
Run in your terminal:
```bash
claude mcp add maw -- node C:\laragon\www\multi-ai-workflow\server\mcp\main.ts
```
Or in `~/.claude.json`:
```json
{
  "mcpServers": {
    "maw": {
      "command": "node",
      "args": ["C:\\laragon\\www\\multi-ai-workflow\\server\\mcp\\main.ts"],
      "env": {
        "MAW_URL": "http://127.0.0.1:4317"
      }
    }
  }
}
```

### 2. OpenAI Codex CLI
Add to `~/.codex/config.toml`:
```toml
[mcp_servers.maw]
command = "node"
args = ["C:\\laragon\\www\\multi-ai-workflow\\server\\mcp\\main.ts"]

[mcp_servers.maw.env]
MAW_URL = "http://127.0.0.1:4317"
```

### 3. Gemini CLI
Add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "maw": {
      "command": "node",
      "args": ["C:\\laragon\\www\\multi-ai-workflow\\server\\mcp\\main.ts"],
      "env": {
        "MAW_URL": "http://127.0.0.1:4317"
      }
    }
  }
}
```

### 4. One-Click Registration in UI
Open the **MCP** tab in the Mission Control Dashboard and click **"Đăng ký MCP của dashboard"**. It automatically configures Claude, Codex, and Gemini with automated backup.

---

## 2. Available Tools

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `list_agents` | `{}` | Returns all registered agents and their health / readiness status |
| `create_task` | `{ title, prompt?, project_path?, agent?, role? }` | Adds a task card to the S2 board queue |
| `start_job` | `{ project_path, prompt, agent?, role?, mode?, model?, effort? }` | Dispatches an agent job in the background |
| `job_status` | `{ job_id, tail_bytes? }` | Checks status, exit code, and recent log tail |
| `request_review` | `{ project_path, reviewers? }` | Dispatches a Council Review across multiple agents |
| `inbox` | `{ status?, limit? }` | Inspects open attention requests requiring user input |
