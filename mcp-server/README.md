# Job Agent MCP server

Exposes the running Job Agent as [Model Context Protocol](https://modelcontextprotocol.io)
tools: `list_jobs`, `score_job`, `source_health`, `agent_status`, `trigger_scrape`.
Any MCP client — Claude Desktop, Gemini CLI, Antigravity — can then talk to
your job board conversationally.

```bash
cd mcp-server && npm install
```

Client config (Claude Desktop `claude_desktop_config.json` shown; other
clients are analogous):

```json
{
  "mcpServers": {
    "job-agent": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/index.mjs"],
      "env": {
        "JOB_AGENT_URL": "https://your-app.fly.dev",
        "JOB_AGENT_PASSWORD": "your APP_PASSWORD"
      }
    }
  }
}
```

`trigger_scrape` spends real LLM tokens — the tool description tells the model
to confirm with you first.
