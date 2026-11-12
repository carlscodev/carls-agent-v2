---
name: carls-code-mcp
description: Connect Model Context Protocol servers so the agent gains new tools and context at runtime.
version: 1
when_to_use: Use when the user wants to add an MCP server, connect an external tool, or expose an API to the agent.
tags: [mcp model context protocol tools integration server stdio context]
---
# Adding MCP servers

MCP servers extend the agent with tools it did not ship with. carls-code loads
them at startup from the `mcpServers` block of any config layer.

## Configuration

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": { "LOG_LEVEL": "warn" }
    },
    "remote": {
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer token-from-env" }
    }
  }
}
```

- `command` servers are stdio: carls spawns the process and speaks JSON-RPC over
  stdin/stdout. Prefer these; no network exposure.
- `url` servers are HTTP/SSE. Only use ones you trust with your files.
- Put secrets in `env` via environment variables, never inline in a committed
  file.

## What happens on connect

1. `src/mcp/McpClient.ts` spawns or connects to the server.
2. The tool list is fetched and each tool is registered in the `ToolRegistry`,
   namespaced as `mcp__<server>__<tool>`.
3. MCP tools default to the `write` category, so the permission gate applies.
   Read-only MCP tools can be marked `read` if the server declares them so.

## Adding a server to this codebase

- Schema: `src/config/Config.ts` (`mcpServers` field).
- Client: `src/mcp/McpClient.ts`.
- Registration: `Runtime` constructor, after the built-in tools.
- Tests: a tiny fake server on `127.0.0.1` that answers `initialize` and
  `tools/list`. Do not require network access in tests.

## Debugging

Run with `--debug`. A server that fails to start logs the exit code and the last
lines of its stderr; it never crashes the agent.
