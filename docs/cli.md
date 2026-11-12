# CLI and REPL

## Flags

| Flag | Meaning |
| --- | --- |
| `carls` | interactive REPL |
| `carls "query"` / `carls -p "query"` | one turn, then exit (print mode) |
| `-m, --mode <mode>` | `plan`, `pair`, `ask`, `build`, `auto`, `yolo` |
| `--plan`, `--yolo` | shorthands for the two extremes |
| `--effort <level>` | `minimal`, `low`, `medium`, `high` |
| `--model <id>`, `--provider <id>`, `--base-url <url>` | override the config for this run |
| `--max-steps <n>`, `--max-tokens <n>` | loop and output limits |
| `--tools <a,b,c>` | tools advertised to the model |
| `--resume [id]` | continue the latest session in this directory, or one by id |
| `--setup` | provider wizard (writes the config, no restart needed) |
| `--providers` | list every bundled provider and its credential variable |
| `--doctor` | config, credentials, endpoint, MCP and update status |
| `update [--check] [--ref <tag>] [--dry-run]` | install, or only report, the latest release |
| `-v, --version`, `-h, --help` | version and help |

Print mode writes the answer to stdout and everything else to stderr, so
`carls -p "…" | jq` and `carls -p "…" > out.txt` both behave.

## The prompt

| Input | Meaning |
| --- | --- |
| text | a task for the agent |
| `/` | command palette (also `Ctrl+P`) |
| `!<command>` | run a shell command in the workspace, no model call |
| `#<note>` | append a note to the session context, no model call |
| `@` | pick a file and attach its contents to the message |
| `Shift+Tab` | cycle the permission mode |
| `Ctrl+C` | interrupt the running turn; twice to exit |

While a turn is running the spinner shows the current step and elapsed seconds.
`Esc`/`Ctrl+C` aborts the turn without ending the session.

## Commands

| Command | Purpose |
| --- | --- |
| `/help` | every command with a one-line summary |
| `/models [filter]` | browse the endpoint's models, pick one, set its effort |
| `/model [id]` | show or set the model |
| `/effort <level>` | reasoning effort |
| `/mode <mode>` | permission mode |
| `/status` | model, mode, effort, context usage, cost |
| `/cost` | spend for this session |
| `/context` | token usage of the transcript |
| `/compact` | compact now instead of waiting for the threshold |
| `/clear` | start a fresh session |
| `/undo [n]`, `/redo [n]` | revert the last edits, or re-apply what an undo removed |
| `/files`, `/diff` | files the agent touched, and the working-tree diff |
| `/todo` | the agent's current plan |
| `/agent <goal>` | run an isolated sub-agent and print its conclusion |
| `/tools` | every tool, its category, parallel-safe and advertised flags |
| `/mcp` | connected MCP servers, transport and tool counts |
| `/skills [list\|search\|show\|review\|new]` | browse and review reusable procedures |
| `/sessions`, `/resume <id>` | session picker and direct resume |
| `/config`, `/permissions`, `/theme`, `/init` | configuration, policy, colours, `AGENTS.md` setup |
| `/providers`, `/setup`, `/doctor` | provider list, wizard, diagnostics |
| `/update [--check]` | install or check for a newer release |
| `/retry` | re-run the last task |
| `/exit` | leave |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | the turn completed, or the command succeeded |
| 1 | the turn ended in an error, or the update failed |
| 2 | bad arguments, missing credentials, or cancelled setup |

## Theme

`/theme dark|light` switches palettes. Colour degrades truecolor → 256 → plain,
and `NO_COLOR=1` (or a non-TTY) drops colour entirely, which is what keeps piped
output clean.
