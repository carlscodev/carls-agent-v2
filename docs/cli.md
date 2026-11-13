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
| `--agent <name>` | start with a preset from `.agents/agents/<name>.md` |
| `--max-steps <n>`, `--max-tokens <n>` | loop and output limits |
| `--tools <a,b,c>` | tools advertised to the model |
| `--resume [id]` | continue the latest session in this directory, or one by id |
| `--setup` | provider wizard (writes the config, no restart needed) |
| `--providers` | list every bundled provider and its credential variable |
| `--doctor` | config, credentials, endpoint, MCP and update status |
| `--install-win` | copy `carls.exe` to `%LOCALAPPDATA%\carls\bin`, add it to the user `Path`, then exit (Windows only) |
| `--uninstall-win` | remove the per-user Windows files and the exact `Path` entry, then exit |
| `--no-alt-screen` | keep the legacy inline layout instead of the alternate-screen TUI |
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
| `@` | pick a file and attach its contents to the message (also works in `-p`) |
| `Shift+Tab` | cycle the permission mode |
| `Tab` (empty composer) | cycle the permission mode in the full-screen TUI |
| `PgUp` / `PgDn`, `Shift+Up/Down`, mouse wheel | scroll the virtual conversation viewport |
| `End` (empty composer) | jump back to the live edge |
| `Ctrl+B` | toggle the split inspector (plan, files, skills, rules) |
| `Ctrl+C` | interrupt the running turn; twice to exit |

While a turn is running the spinner shows the current step and elapsed seconds.
`Esc`/`Ctrl+C` aborts the turn without ending the session.

Typing while the agent works **steers** it: Enter sends the line into the turn
that is already running, so it reaches the model at the next step boundary with
all the observations gathered so far — no need to abort and repeat yourself.
Escape discards what you typed, Ctrl+C aborts the turn.

A steer that arrives after the model's last step still runs: it becomes a new
turn, in order, and the footer shows `↑n queued` meanwhile. Each queued prompt
expands its own `@file` mentions. While an approval question is on screen the
composer steps aside, so answering `y` cannot also steer the turn.

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
| `/checkpoint [label]` | snapshot the whole working tree to a private git ref |
| `/rewind [id\|list]` | restore the working tree to a checkpoint (snapshots first, so it is undoable) |
| `/agents [name]` | switch the agent preset from `.agents/agents/*.md` |
| `/export [path]` | write the session transcript to a markdown file |
| `/editor [text]` | compose the prompt in `$VISUAL`/`$EDITOR` and load it back |
| `/files`, `/diff` | files the agent touched, and the working-tree diff |
| `/todo` | the agent's current plan |
| `/plan` | the persistent task graph, where it stopped and what runs next |
| `/rules [forget <id>]` | rules learned from corrections, and how to drop one |
| `/receipt` | what the last task changed, verified and rolled back |
| `/agent <goal>` | run an isolated sub-agent and print its conclusion |
| `/tools` | every tool, its category, parallel-safe and advertised flags |
| `/mcp` | connected MCP servers, transport and tool counts |
| `/skills [list\|search\|show\|review\|new]` | browse and review reusable procedures |
| `/sessions`, `/resume [id]` | session selector; `/resume` with no id opens the list (or loads the only session), and an id resumes it directly |
| `/config`, `/permissions`, `/theme`, `/init` | configuration, policy, colours, `AGENTS.md` setup |
| `/providers`, `/setup`, `/doctor` | provider list, wizard, diagnostics |
| `/update [--check]` | install or check for a newer release |
| `/install-win`, `/uninstall-win` | per-user native install and cleanup (Windows) |
| `/retry` | re-run the last task |
| `/exit` | leave |

## Full-screen TUI

Interactive runs (`stderr` is a TTY) use the alternate screen by default:

- a one-row header with version, agent mode, provider/model, short cwd and session id;
- a virtual scrollback viewport (`Viewport`) that keeps the header, composer and
  footer at fixed rows while the mouse wheel, `PgUp`/`PgDn`, `Shift+Up/Down`
  move through history;
- a floating dock above the composer for completion menus, `/resume`, approvals
  and `ask_user`;
- a three-row mode-colored composer (green build/auto/yolo, cyan plan, amber ask)
  and a one-row tactical footer with the live spinner, step, tool timer and
  token rate;
- a one-column scrollbar and a "new messages" pill when the view is detached
  from the live edge.

`AnimationTicker` refreshes the footer every 80 ms only while a turn is busy and
stops with zero timers when it ends. Use `--no-alt-screen` (or a non-TTY
`stderr`) for the legacy inline layout; `-p` never enters the alternate screen
and stdout stays the model's answer only.

## Autocomplete

The menu is scoped to what the token under the cursor can accept. The first
token lists slash commands; `/resume ` lists saved sessions from `SessionStore`
as `id · age · cwd · "opening" (N msgs)`, and accepting a row inserts the id.
`/resume` with no argument opens the interactive selector (or loads the only
session). Workspace files are only offered by the explicit `@` picker, never as
a slash-command argument.

When the current directory is the user's home, the `@` picker and `glob_files`
ignore `AppData`, `Windows`, `Program Files`, `NTUSER*`, `.cache`, `Library` and
the other system/profile directories, and cap the walk at 200 paths and two
levels. Nothing is scanned at REPL startup; the listing is built on demand when
`@` is typed.

## Native Windows build

`npm run build:exe` (after `npm install`) produces:

| Artifact | Purpose |
| --- | --- |
| `release/carls.bundle.cjs` | one self-contained CommonJS file with every runtime dependency, the builtin skills and the version embedded |
| `release/sea-config.json` | Node SEA config (`useCodeCache: true`, warning disabled) |
| `release/sea-prep.blob` | the SEA payload |
| `release/carls.exe` | `node.exe` with the blob in a `NODE_SEA_BLOB` resource and the SEA fuse flipped |
| `release/carls.cmd` | launcher that starts the exe without npm |

`npm run build:bundle` stops after the bundle. Piping `carls.exe` through
`--install-win` copies it to `%LOCALAPPDATA%\carls\bin` and appends that
directory to the **user** `Path` only when it is missing; the existing value is
read without `%VAR%` expansion and never truncated (no `setx`). Open a new
terminal afterwards. `--uninstall-win` removes the files and that one entry.

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
