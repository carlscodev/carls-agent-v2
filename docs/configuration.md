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
| `lspServers` | — | language servers for `lsp_diagnostics`, keyed by extension or file name |

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
| `CARLS_SEARCH_ENDPOINT` | override the `web_search` endpoint (mirrors, tests) |
| `CARLS_PREFIX`, `CARLS_REPO`, `CARLS_REF` | installer prefix, repository, and ref/tag to install |
| `NO_COLOR` | disable colour |

## Files it writes

| Path | What |
| --- | --- |
| `~/.carls/sessions/` | transcripts, one JSONL per session (`/resume`) |
| `~/.carls/update-check.json` | cached release check (24h), plus which version was auto-installed or failed |
| `.carls/skill-usage.json` | skill usage ledger (`/skills review`) |
| `.carls/backups/` | file snapshots behind `/undo` and `/redo` |

## Language servers

`lsp_diagnostics` runs the server you name here and opens the file in it. Nothing
is installed or guessed — a coding agent spawning an unexpected binary is not a
feature.

```json
{
  "lspServers": {
    ".ts": { "command": "typescript-language-server", "args": ["--stdio"] },
    ".py": { "command": "pylsp", "args": [] },
    "go":  { "command": "gopls", "args": [] }
  }
}
```

The key is an extension (`.ts`) or a file name (`Makefile`). `languageId`
overrides the id sent to the server (default: the extension without the dot) and
`initOptions` is passed as `initializationOptions`. A missing server for a file is
reported as a tool error with this example, not as a crash.

## Agent presets

A preset is a markdown file with frontmatter. The body is appended to the system
prompt; the frontmatter narrows the session:

```markdown
---
description: Reviews a diff for correctness, never edits
mode: plan
tools: read_file, grep_search, glob_files, bash
effort: high
---
You are a reviewer. Read the diff, list concrete defects with file and line,
and stop. Do not edit anything.
```

Where they live, project first:

| Path | Scope |
| --- | --- |
| `.agents/agents/<name>.md` | this project, committed with the code |
| `~/.carls/agents/<name>.md` | every project on this machine |

A project file wins over a global one with the same name. Only keys the preset
sets are applied: no `model` keeps your model, no `mode` keeps your mode. Invalid
values (`mode: sideways`) are ignored instead of failing the session, and a file
without frontmatter is simply instructions.

### Permission blocks

A preset can narrow what the agent is allowed to do, which is what makes a
`reviewer` that cannot write trustworthy:

```markdown
---
description: Reviews diffs, never edits
permission:
  edit: deny
  webfetch: deny
  bash:
    "*": ask
    "git diff": allow
    "git log*": allow
    "rm -rf *": deny
---
You review diffs and report findings only.
```

| Value | Meaning |
| --- | --- |
| `edit: deny` | every file-mutating tool is refused (`edit_file`, `write_file`, `apply_patch`, …) |
| `edit: allow` | those tools run without prompting, even in `ask` mode |
| `webfetch: deny` | `web_fetch`, `web_search`, `network_request`, `http_download` are refused |
| `bash: { "pattern": allow }` | the command runs without prompting (glob, last rule wins) |
| `bash: { "pattern": deny }` | the command is refused even in `auto` mode |
| `ask` | the default: prompt in `ask`/`build`, allowed in `auto` |

A `deny` always wins over an `allow`. `yolo` still overrides everything, and
`/agents` shows the rules it applied. The same rules are available without a
preset through `permissions.toolAllow` / `permissions.toolDeny`.

```bash
carls --agent reviewer "look at the last commit"
```

Inside a session, `/agents` opens a picker (or `/agents reviewer`) and switches
live: mode, advertised tools, model, effort and instructions.

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
