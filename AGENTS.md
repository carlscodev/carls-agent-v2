# AGENTS.md

Project memory for `carls-code`, an autonomous coding-agent CLI harness.

## Commands

```bash
npm install
npm run typecheck    # tsc --noEmit (must stay clean, strict + exactOptionalPropertyTypes)
npm test             # vitest, 125 tests
npm run build        # tsc -> dist/
npm run dev          # run from source via tsx
node ./bin/carls.mjs --help
```

`bin/carls.mjs` imports `../dist/src/index.js`, so `npm run build` is required
before running the built CLI. Keep the `dist/src` path in mind if you change
`rootDir` or `outDir`.

## Layout

- `src/types/` — the shared contracts (`llm.ts`, `tools.ts`, `agent.ts`). These
  are the anchor for cross-file consistency; change them first, then the
  implementations.
- `src/core/` — `AgentLoop` (gather-act-verify), `ContextManager` (compaction,
  truncation), `SubAgent`, `Runtime` (wiring), `SessionStore`, `CostTracker`,
  `Hooks`, `MemoryLoader`.
- `src/tools/` — one file per tool; each implements `Tool<I>` with a zod
  `inputSchema`, and `schema()` derives JSON Schema via `utils/schema.ts`.
- `src/providers/` — `registry.ts` (every provider: id, family, protocol, base
  URL, credential variables, default and known models), `ProviderBase.ts`
  (`createProvider` dispatches on the registry: Anthropic protocol ->
  `AnthropicProvider`, everything else -> `OpenAICompatProvider`), plus
  `retry.ts` (backoff). Adding a provider is one object in the registry; the CLI,
  the onboarding wizard, `/doctor`, the model catalog and `scripts/install.sh`
  all read from it.
- `src/setup/` — `Onboarding.ts` (first-run wizard: provider, credential, model,
  mode, effort, then a live probe with a key-retry loop) and `writeConfig.ts`
  (used by the installers; accepts a custom provider id only with a base URL).
- `src/utils/platform.ts` — every platform difference (shell, `ps`/`tasklist`,
  clipboard, config/cache/data paths, path comparison, Windows virtual terminal).
  Do not branch on `process.platform` elsewhere; add a helper here.
- `src/security/PermissionGate.ts`, `src/mcp/McpClient.ts`, `src/cli/`, `src/utils/`.

## Conventions and invariants

- **stdout is reserved for the model's answer.** All diagnostics, spinners, tool
  streaming and permission prompts go to stderr, so `carls -p "..." | jq` works.
- **Tools never throw.** Return `{ ok: false, error }`; `bash` reports non-zero
  exit codes as data. `AgentLoop.executeTool` also wraps `tool.run` in try/catch
  as a second line of defence.
- **Tool schemas are derived from zod**, never hand-written twice.
- **Compaction must cut at a tool-pair boundary.** A `tool_result` may not be
  separated from its `tool_use`, or the provider rejects the request. See
  `ContextManager.safeCutIndex`.
- **Sub-agents get read-only tools and no `spawnSubAgent`** (see
  `Runtime.subAgentToolContext`), which caps nesting.
- **Consecutive read-only calls in one assistant turn run in parallel**
  (`AgentLoop`, capped by `MAX_PARALLEL_TOOLS`). That covers `read_file`,
  `grep_search`, `glob_files`, `multi_read` and `delegate_task`. Any call with a
  side effect breaks the batch and runs alone, so write/shell ordering is
  unchanged. `mapWithConcurrency` preserves input order because the
  `tool_result` blocks must line up with their `tool_use` blocks, and
  `runToolUse` never throws so one failure cannot reject a whole batch.
- **MCP servers are transport-agnostic.** `src/mcp/transports.ts` owns the wire
  (stdio newline-JSON, legacy `sse` two-endpoint, and Streamable `http`), and
  `McpClient` owns the protocol (handshake, id correlation, tools/list,
  tools/call). A config entry with `url` defaults to `http`; `transport: "sse"`
  selects the older pair. A duplicate tool name from a second server is skipped
  with a warning instead of aborting startup, and an `annotations.readOnlyHint`
  makes the wrapped tool eligible for parallel execution.
- **The installers are self-bootstrapping.** `curl … | bash` leaves `$0 = bash`,
  so `scripts/install.sh` downloads `codeload.github.com/$CARLS_REPO/tar.gz/$CARLS_REF`
  and re-execs itself from that tree (`CARLS_BOOTSTRAPPED=1` prevents a loop).
  `scripts/install.ps1` does the same with the zip and `@PSBoundParameters`.
  Keep both paths working: the public one-liner in README is the only install
  most users ever run.
- **Updates are installer re-runs pinned to a tag.** `src/update/Updater.ts`
  compares `packageVersion()` against the GitHub release (falling back to tags)
  and runs the installer with `--ref <tag>`, so an update cannot land on a
  different build than the one reported. `installerPlan` is pure so tests never
  execute an installer. The startup notice is cached for 24h, stderr-only, never
  awaited, and silenced by `CARLS_NO_UPDATE_CHECK=1`.
- **Secrets** are read from the environment first and passed through
  `Logger.redact` before reaching the model, a log line or an error message.
  `redact` knows the key format of every bundled provider plus JWTs and
  `key=value` pairs; extend `KEY_PATTERNS` when adding a provider with a new
  prefix.
- **File tools are confined to the workspace.** They resolve paths through
  `guardPath` (`utils/paths.ts`), which throws `PathGuardError` for anything
  outside `cwd` unless the config sets `allowOutsideWorkspace` (or
  `CARLS_ALLOW_OUTSIDE=1`). A tool that wants a friendlier message catches the
  throw; `FileRead`/`FileWrite` do.
- **The permission gate never blocks on a prompt it cannot answer.** With the
  real terminal prompt and `process.stdin.isTTY !== true`, it refuses the call
  and prints how to allow it. A gate built with an injected `prompt` (tests,
  scripts) skips that check.
- `/setup` and `--setup` treat the current provider and model as *defaults*: the
  wizard still asks. `preset.provider`/`preset.model` (from `--provider`/`--model`)
  skip the question; `defaultProvider`/`defaultModel` only pre-highlight it. Do not
  turn a default into a silent decision, or `/setup` can never switch provider.
- The footer (mode, model, context) is only redrawn by `showStatus()`. Any code
  path that changes a visible setting must call it: `cycleMode` (Shift+Tab) and
  the command loop (`/mode`, `/model`) both do. Forgetting it makes the change
  invisible until the next turn ends.
- Shift+Tab is `\u001b[Z` (CSI Z); readline reports it as `tab` with `shift: true`
  and a `sequence` of `undefined`. Notes written while the cursor is on the prompt
  row land outside the scrolling region and are erased by the next prompt repaint,
  so `Chrome.moveToRegionBottom()` must come first.
- All terminal text measurement goes through `src/cli/Text.ts`
  (`visibleWidth`/`truncate`/`pad`/`wrap`). Never count escape sequences as
  characters: a line one column too wide wraps, adds a row Chrome does not know
  about, and desyncs the scrolling region by one row on every scroll.
- `bannerLines` must return lines that fit the terminal; a long model id is the
  usual culprit. Tests in `tests/smoke.test.ts` assert this across widths.
- `src/cli/SelectList.ts` is the shared full-screen picker (sessions, models). It
  runs in the alternate screen buffer and pads every row to the width. Callers
  reach it via `selectList`, and the REPL suspends `Chrome` around commands so
  the frame never lands inside the scrolling region.
- `scripts/install.sh` sources `scripts/lib/node-bin.sh`; keep testable installer
  logic in that directory. The launcher must embed a node that exists: `ensure_node`
  keeps the system node, so `$CARLS_NODE_DIR/bin/node` is often absent. A user-scope
  install must never sudo-write `/usr/local/bin`, and uninstall only removes links
  that point at its own prefix.
- The installer writes the shared `/opt/carls/.carlsrc.json` (linked as
  `/etc/carls/.carlsrc.json`) mode 644 on purpose, so non-root users can read it.
  Only per-user configs, which may hold a key, stay at 600.
- Workspace containment is lexical *and* symlink-aware: `guardPath` rejects a path
  whose realpath lands outside the root (`assertNoSymlinkEscape`), because
  `ln -s /etc ./link` otherwise slips past a pure `path.relative` check.
- Tests live in `tests/smoke.test.ts` and exercise real code paths (real
  filesystem, real `bash`). The `AgentLoop` integration tests use a scripted
  in-process `Provider` — not a mock of the loop — because no network/API key is
  available in CI.

## REPL command surface

Commands live in `src/cli/Commands.ts` as a `COMMANDS` array of `CommandSpec`
(name, optional aliases, usage, summary, run). Add a command by appending one
entry; `/help` renders from the same list. Current set: `/help`, `/models`,
`/model`, `/effort`, `/mode`, `/status`, `/cost`, `/undo`, `/todo`, `/files`,
`/agent`, `/tools`, `/diff`, `/sessions`, `/resume`, `/clear`, `/compact`, `/retry`, `/setup`, `/providers`, `/config`, `/doctor`, `/init`, `/skills`,
`/mcp`, `/update`, `/exit`. `!<cmd>` is shell passthrough and `# <note>` appends context without a
model call. `/setup` writes the config, reloads it and calls
`Runtime.rebuildProvider()` so the next turn uses the new provider in place.

Interactive UI helpers:

- `src/cli/Input.ts` — `LineReader` (one short-lived readline per prompt, so raw
  selectors never fight it for stdin) and `RawSession` (raw-mode key reader).
- `src/models/Selector.ts` — model picker; cycles effort with `←`/`→`/`e`, `Enter`
  selects, `q` cancels. Non-TTY callers get `renderModelList` instead.
- `src/cli/Markdown.ts` — streaming markdown renderer for assistant output.
- `src/cli/TerminalUI.ts` — banner, panels, spinners, tags.

Never attach a second `readline` while a selector is active; that was the bug
where pressing `e` in `/models` swallowed the keypress and the REPL exited.

## Permission modes

`plan` (read-only), `ask` (prompt for writes and shell), `build` (writes auto,
shell prompts), `auto` (all auto except the deny-list), `yolo` (deny-list
included). Defined in `src/config/Config.ts`; enforced in
`src/security/PermissionGate.ts`. `--plan`/`--yolo` are shorthands.

## Skills

`.agents/skills/<name>/SKILL.md` and `~/.carls/skills/` hold reusable
procedures; `skills/` in this repo is the bundled catalog. Load one with the
`use_skill` tool, add one with `save_skill`, and inspect them with `/skills`.
The usage ledger is `.carls/skill-usage.json`; `/skills review` shows flagged or
unused entries. When adding a bundled skill, keep the frontmatter
(`name`, `description`, `when_to_use`, `tags`, `version`) and write concrete
rules with file paths, not general advice.

## Interface invariants

- The REPL keeps a fixed header and footer via `Chrome` (terminal scrolling
  region). Never write raw newlines outside the scrolling region while it is
  active, or the header is overwritten.
- `Prompt` owns stdin in raw mode. A selector must not attach a second
  `readline` while it runs.
- Colour comes from `Theme.ts` (`theme().paint(token, text)`), never raw
  `picocolors` in view modules. `paint` degrades truecolor -> 256 -> plain, and
  `NO_COLOR`/non-TTY drop colour entirely.
- Tool calls render through `ToolView` as a glyph line plus an optional block
  body, not raw JSON. `edit_file` and `write_file` suppress the call line and
  carry their title on the result instead, so the path is still visible; any new
  deferred tool must do the same or the user loses the filename.
- Every rendered block is bounded (`MAX_BODY_LINES`/`MAX_BODY_CHARS`). Shell
  output keeps its tail, because the failure is at the end.
- A banner or panel line that is one column too wide wraps in the terminal, adds
  a row `Chrome` does not know about, and desyncs the fixed layout by one row per
  scroll. Assert `visibleWidth(line) <= width` when touching `bannerLines`.
- Widths are measured after stripping ANSI escapes, and every repeat is guarded
  with `Math.max(2, n)`.
- The command palette (`CommandPalette.ts`) is a view over `COMMANDS`; it returns
  the chosen command string and the REPL dispatches it, so adding a command needs
  no palette change. Bare `/` and `Ctrl+P` open it, and `Chrome.suspend()` must
  wrap any full-screen selector.

## Verification habit

After edits, run `npm run typecheck && npm test`. For end-to-end checks without
credentials, point `--provider openai --base-url http://127.0.0.1:<port>/v1` at a
tiny fake OpenAI-compatible HTTP server and set a dummy `OPENAI_API_KEY`.

The wizard is pipeable, which makes it testable and scriptable:

```bash
printf 'nvidia\nnvapi-...\n\n\n\n' | HOME=$(mktemp -d) carls --setup
```

`LineSource` in `Onboarding.ts` reads a pipe once and serves lines in order, so
answers line up with prompts. On a TTY it opens one readline per question instead.
Tests drive it with a `PassThrough` stream and `outPath` in a temp dir.

## Windows

`scripts/install.ps1` installs on Windows 10/11 (winget, then Chocolatey, then
the official MSI), writes a `carls.cmd` shim into `%LOCALAPPDATA%\carls\bin`,
adds it to the user `PATH`, and restricts the config ACL. `enableWindowsVirtualTerminal()`
runs first in `main()` so ANSI output works in `cmd.exe`. When touching anything
path- or shell-related, go through `src/utils/platform.ts`.

## Deployment notes

- Config precedence: `./.carlsrc.json` > `~/.carlsrc.json` > `/etc/carls/.carlsrc.json`
  (override the system path with `$CARLS_SYSTEM_CONFIG`) > defaults. The system
  layer makes `carls` work for every user, including brand-new ones, with no setup.
- A machine-wide install writes the shared `/etc/carls/.carlsrc.json` mode 644 on
  purpose so every user can read it. A key placed there is readable by any local
  account, so prefer the provider's environment variable in that layer.
- A deployed tree needs `dist/` **and `skills/`**: without `skills/` the bundled
  catalog is empty for every user.

Free apinex models verified working with tool-calling: `free/glm-5.3-flash`,
`free/deepseek-v4.1-flash`, `free/kimi-k3`, `free/gpt-6-luna`. `free/minimax-m3`
and `free/claude-*` require a paid subscription. Rate limit: 15 RPM (the client
honours `Retry-After`).
