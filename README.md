# carls-code

[![CI](https://github.com/BerunHaider/carls-agent-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/BerunHaider/carls-agent-v2/actions/workflows/ci.yml)

An autonomous coding agent that runs in your terminal. It reads your repository,
makes the change, runs your tests, and keeps going until the work actually
passes — with a permission gate in front of anything destructive.

Strict TypeScript, native ESM, Node.js 20+. No runtime dependencies beyond zod
and the provider SDKs.

## What makes it different

- **Reads run in parallel.** Independent `read_file`, `grep_search`, `glob_files`
  and sub-agent calls issued in one turn execute concurrently (up to six), so a
  turn costs the slowest observation instead of the sum of all of them.
  Writes and shell commands stay strictly ordered.
- **Compaction you can trust.** Past 75% of the context window the conversation
  folds into a structured checkpoint (goal, files touched, errors resolved, next
  step), cut only at a safe tool-pair boundary so the provider never rejects it.
- **Sub-agents keep the main context clean.** `delegate_task` runs an isolated
  read-only loop and returns a conclusion, not a transcript.
- **Every provider, one config.** 33 bundled ids plus any OpenAI-compatible
  gateway, and keyless local backends (Ollama, LM Studio, vLLM, llama.cpp).
- **MCP over three transports.** stdio, SSE and Streamable HTTP, including
  remote servers with a bearer token.
- **Updates pinned to a tag.** `carls update` installs exactly the release it
  reported.

## Install

Linux and macOS, one line:

```bash
curl -fsSL https://raw.githubusercontent.com/BerunHaider/carls-agent-v2/main/scripts/install.sh | bash
```

Windows 10/11 (PowerShell, no admin needed when Node.js is present):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/BerunHaider/carls-agent-v2/main/scripts/install.ps1))) -Yes
```

Both installers are self-bootstrapping: they download the requested ref
(`--ref`, default `main`), build it and install it. They reuse an API key already
exported in your shell and write a config, so the first run needs no setup.
From a clone, `./scripts/install.sh` or `.\scripts\install.ps1` install that
working tree instead.

Verify the install:

```bash
carls --version
carls --doctor
```

## Quick start

```bash
carls                                   # interactive session
carls "fix the failing tests in src/core"  # one turn, then exit
carls --plan "how would you split this module?"  # read-only plan
carls --resume                          # continue the last session here
```

The first run asks for a provider, a key and a model. `/setup` changes them at
any time without a restart.

## Update

```bash
carls update              # install the latest release
carls update --check      # only report current vs latest
carls update --ref v0.2.0 # reinstall a specific tag
```

Once a day the interactive startup prints one line when a newer release exists;
`CARLS_NO_UPDATE_CHECK=1` disables the check.

## How it works

```
gather  →  act  →  verify
  reads     minimal edits    your tests, linter or compiler, until they pass
```

The agent explores before it edits, prefers small reviewable changes, and never
claims something works without running it.

| Subsystem | What it does |
| --- | --- |
| Agent loop | gather-act-verify, parallel read-only batches, abort mid-turn |
| Context | token budget, 75% compaction, checkpoint summaries, bounded observations |
| Sub-agents | isolated read-only exploration with a structured report |
| Permissions | six modes from read-only to full auto, allow/deny lists, diff preview |
| Tools | 48 built-in plus MCP, every schema derived from zod |
| MCP | stdio, SSE, Streamable HTTP, `/mcp` inspection |
| Skills | reusable procedures in three layers, with a usage ledger |
| TUI | fixed header, scrolling region, streaming markdown, real diffs, command palette |

## Commands

Inside the session: `/` or `Ctrl+P` opens the palette, `Shift+Tab` cycles the
permission mode, `!` runs a shell command, `#` adds a note without calling the
model.

| Command | Purpose |
| --- | --- |
| `/models`, `/model`, `/effort` | pick a model and its reasoning effort |
| `/mode` | `plan`, `pair`, `ask`, `build`, `auto`, `yolo` |
| `/status`, `/cost`, `/context` | what the session is spending |
| `/undo`, `/redo`, `/files`, `/diff` | revert, re-apply, list and inspect the agent's edits |
| `/compact`, `/clear`, `/resume` | context and sessions |
| `/agent <goal>` | run a sub-agent and print its conclusion |
| `/tools`, `/mcp`, `/skills` | what the agent can use |
| `/setup`, `/providers`, `/doctor` | configuration and diagnostics |
| `/update [--check]` | install or check for a newer release |

Full list with keybindings: [docs/cli.md](docs/cli.md).

## Configuration

One JSON file, layered `./.carlsrc.json` → `~/.carlsrc.json` →
`/etc/carls/.carlsrc.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "mode": "ask",
  "permissions": { "allow": ["npm test", "git status"], "deny": ["git push *"] },
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp" }
  }
}
```

Every key, provider rule, hook and environment variable:
[docs/configuration.md](docs/configuration.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | request lifecycle, compaction, sub-agents, interface invariants, module map |
| [docs/configuration.md](docs/configuration.md) | every config key, permissions, MCP, hooks, env vars, files written |
| [docs/tools.md](docs/tools.md) | the full tool catalog |
| [docs/cli.md](docs/cli.md) | flags, keybindings, commands, exit codes |
| [docs/parity.md](docs/parity.md) | implemented capabilities and what is deliberately still missing |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest
npm run build       # tsc -> dist/
node ./bin/carls.mjs --help
```

`AGENTS.md` is the instruction file the agent reads on every turn — edit it to
change how the agent works in your repository.

## License

MIT.
