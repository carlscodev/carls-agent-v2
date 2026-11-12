# Capability status

An honest inventory, kept so nobody has to guess what is actually implemented.
"Parity" here means the feature exists and is tested, not that it matches another
project line by line. Nothing in this repository is copied from another agent; the
terminal vocabulary (glyphs, panels, mode cycling) is our own.

## Working today

| Area | Status |
| --- | --- |
| Agent loop | gather → act → verify, `--max-steps`, abort mid-turn |
| Parallel read-only tools | up to 6 concurrent calls per turn |
| Context compaction | 75% threshold, tool-pair-safe cut, checkpoint summary, `/compact` |
| Sub-agents | `delegate_task`, read-only, no nesting, structured report |
| Sessions | persisted transcripts, `/resume`, `/sessions` picker |
| Undo / redo | per-file snapshots behind `/undo`, session redo stack behind `/redo` |
| `@file` mentions | `@` opens a picker over tracked files; the content rides along in the message, capped at 8 files / 60k chars |
| Providers | 33 bundled ids, custom gateway via `baseUrl`, Ollama/LM Studio/vLLM/llama.cpp |
| Models | `/models` against the live endpoint, effort plumbing |
| Permissions | 6 modes, allow/deny lists, diff preview, `Shift+Tab` |
| MCP | stdio, SSE and Streamable HTTP, remote auth, `/mcp` |
| Skills | discovery from 3 layers, usage ledger, review queue, `save_skill` |
| Tools | 48 built-in, plus MCP tools, all zod-schema'd |
| Hooks | `preToolUse` / `postToolUse` / session events |
| Plan / todo | `todo_write`, `/todo` |
| Terminal UI | fixed header, scrolling region, boxed panels, diffs, markdown stream, palette |
| Themes | dark/light, 256-colour and no-colour degradation |
| Print mode | stdout answer only, pipeable |
| Install | one-line curl (Linux/macOS) and PowerShell (Windows), self-bootstrapping |
| Updates | `carls update`, tag-pinned, cached startup notice |
| Diagnostics | `/doctor` covering config, credentials, endpoint, MCP, updates |
| CI | Linux + macOS on Node 20/22/24, installer end to end on both, Windows job for build + CLI + PowerShell installer |
| Releases | tag-driven; the release is what `carls update` reads, installers attached |

## Missing, in the order I would build it

1. **Custom agent definitions.** The six permission modes are fixed. A
   `.agents/agents/<name>.json` with its own prompt, tool set and permission
   policy would let a project define `reviewer`, `migrator`, `docs` and switch
   with `Tab`.
2. **LSP diagnostics.** An `lsp` tool that reports errors and hover info after an
   edit would catch whole classes of mistakes without running a build.
3. **`websearch` / `webfetch`.** `network_request` exists but returns raw HTML;
   a reader-mode fetch and a search tool are not implemented.
4. **Session tabs and a sidebar.** One session on screen at a time today.
5. **External editor handoff** (`/editor`, `$EDITOR`) for long prompts.
6. **Queue and steer.** Submitting while a turn runs queues nothing yet.
7. **Headless server + remote client.** The runtime is embeddable, but there is
   no HTTP/WS server mode.
8. **Custom keybinds and per-project TUI config.**
9. **Export/share.** No `/export`, no share links.
10. **Plugins.** No plugin API; MCP tools, skills and hooks are the extension
    points.

## Ground rules for closing the list

- Nothing lands without a test in `tests/smoke.test.ts` and a clean
  `npm run typecheck`.
- No feature is announced before it is verified end to end, including the
  installer and update paths.
- The interface invariants in `docs/architecture.md` are not negotiable: stdout
  stays the answer, width math goes through `Text.ts`, and a banner line never
  exceeds the terminal width.
