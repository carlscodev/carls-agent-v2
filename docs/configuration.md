# Configuration

One JSON file, three possible locations, first match wins per layer:

| Layer | Path | Use |
| --- | --- | --- |
| project | `./.carlsrc.json` | per-repository settings, committed or not |
| user | `~/.carlsrc.json` | your own defaults, may hold a key |
| system | `/etc/carls/.carlsrc.json` | machine-wide, written by the installer (override with `$CARLS_SYSTEM_CONFIG`) |

`carls --setup` writes the user layer and reloads it without a restart. The
installer writes the system layer so a brand-new account can run `carls` with no
setup at all.

## Full example

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "mode": "ask",
  "effort": "medium",
  "maxSteps": 30,
  "maxTokens": 8192,
  "contextWindow": 200000,
  "compactThreshold": 0.75,
  "truncateLimit": 8000,
  "bashTimeoutMs": 120000,
  "allowOutsideWorkspace": false,
  "tools": ["read_file", "edit_file", "grep_search", "bash"],
  "permissions": {
    "allow": ["npm test", "npm run *", "git status", "git diff *"],
    "deny": ["rm -rf *", "git push *", "sudo *"]
  },
  "hooks": {
    "preToolUse": ["node scripts/guard.mjs"],
    "postToolUse": [],
    "sessionStart": [],
    "sessionEnd": []
  },
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": { "url": "https://example.com/mcp" },
    "legacy": { "url": "https://example.com/sse", "transport": "sse" }
  }
}
```

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `anthropic` | id from the registry (`carls --providers`), or a custom id together with `baseUrl` |
| `model` | provider default | model id; `/models` browses what the endpoint actually serves |
| `apiKeyEnv` | provider default | environment variable to read the key from |
| `apiKey` | — | literal key, used only when the env var is unset. Keep the file `600` |
| `baseUrl` | provider default | endpoint override; required for a custom `provider` id |
| `mode` | `ask` | `plan`, `pair`, `ask`, `build`, `auto`, `yolo` |
| `effort` | off | `minimal`, `low`, `medium`, `high`; only forwarded to models that accept it |
| `maxSteps` | 30 | model calls per turn before the loop stops with `max_steps` |
| `maxTokens` | 8192 | output cap per model call |
| `contextWindow` | 200000 | tokens before compaction; a local endpoint that reports its own window overrides this unless the key is set explicitly |
| `compactThreshold` | 0.75 | fraction of the window that triggers compaction |
| `truncateLimit` | 8000 | characters kept from one tool observation |
| `bashTimeoutMs` | 120000 | hard timeout for a shell command |
| `allowOutsideWorkspace` | `false` | lets file tools touch paths outside `cwd` (also `CARLS_ALLOW_OUTSIDE=1`) |
| `autoUpdate` | `auto` | `auto` installs a newer release at startup, `notify` only prints the line, `off` never checks |
| `tools` | all | tools advertised to the model. Everything stays callable; this only narrows the prompt |
| `permissions.allow` | — | commands that run without prompting |
| `permissions.deny` | — | commands refused even in `auto` mode (`yolo` ignores the list) |
| `hooks` | `{}` | shell commands around tool use and sessions |
| `mcpServers` | `{}` | MCP servers, see below |

## Permission modes

| Mode | Reads | Writes and edits | Shell |
| --- | --- | --- | --- |
| `plan` | yes | refused | refused |
| `pair` | yes | asks, after clarifying questions | asks |
| `ask` | yes | asks | asks |
| `build` | yes | allowed | asks |
| `auto` | yes | allowed | allowed unless denied |
| `yolo` | yes | allowed | allowed, deny-list included |

`Shift+Tab` cycles them. `--plan` and `--yolo` are shorthands. When stdin is not
a terminal a prompt cannot be answered, so the gate refuses the call and prints
what to allow instead of hanging.

## Providers

Every bundled provider is one entry in `src/providers/registry.ts`; run
`carls --providers` for the live list with each credential variable. A custom
gateway works with two fields:

```json
{ "provider": "my-gateway", "baseUrl": "https://gateway.internal/v1", "model": "some-model" }
```

Keyless backends (Ollama, LM Studio, vLLM, llama.cpp) need no credential and are
detected on localhost by `/doctor`.

## MCP servers

| Shape | Transport |
| --- | --- |
| `{ "command": …, "args": […] }` | stdio, newline-delimited JSON |
| `{ "url": "https://…/mcp" }` | Streamable HTTP (POST per request) |
| `{ "url": "…/sse", "transport": "sse" }` | the older GET-stream + POST-endpoint pair |

Remote servers authenticate with `CARLS_MCP_TOKEN` (sent as a bearer token) or an
`Authorization` / `MCP_TOKEN` entry under the server's `env`. `/mcp` lists what
connected, and `/tools` marks the MCP tools.

## Hooks

Shell commands that receive a JSON payload on stdin and may answer with JSON on
stdout. `preToolUse` can block a call by exiting with code 2 or printing
`{"block": true, "reason": "…"}`. Events: `preToolUse`, `postToolUse`,
`sessionStart`, `sessionEnd`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `<PROVIDER>_API_KEY` | credential for the configured provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) |
| `CARLS_SYSTEM_CONFIG` | use a different system config file |
| `CARLS_ALLOW_OUTSIDE=1` | same as `allowOutsideWorkspace: true` |
| `CARLS_MCP_TOKEN` | bearer token for remote MCP servers |
| `CARLS_NO_UPDATE_CHECK=1` | never check GitHub for a newer release |
| `CARLS_UPDATE_API` | override the release API root (mirrors, tests) |
| `CARLS_PREFIX`, `CARLS_REPO`, `CARLS_REF` | installer prefix, repository, and ref/tag to install |
| `NO_COLOR` | disable colour |

## Files it writes

| Path | What |
| --- | --- |
| `~/.carls/sessions/` | transcripts, one JSONL per session (`/resume`) |
| `~/.carls/update-check.json` | cached release check (24h), plus which version was auto-installed or failed |
| `.carls/skill-usage.json` | skill usage ledger (`/skills review`) |
| `.carls/backups/` | file snapshots behind `/undo` and `/redo` |

## Updates

A check runs at most once per 24h and only in an interactive session, so a
pipeline or `carls -p` never touches the network for it. When a newer release
exists, `autoUpdate` decides what happens:

- `auto` (default): the installer runs in the background at startup, once per
  release. The cache records the version, so a restart does not install it
  again, and a version whose install failed is only ever announced — never
  retried in a loop.
- `notify`: one line on stderr, nothing else.
- `off`: no check at all. `CARLS_NO_UPDATE_CHECK=1` does the same for a single
  process.

`carls update` is always the manual path: it shows the installer's progress and
accepts `--check`, `--ref <tag>` and `--dry-run`.
