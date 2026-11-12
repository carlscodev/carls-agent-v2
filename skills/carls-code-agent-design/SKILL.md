---
name: carls-code-agent-design
description: Change how carls-code looks and behaves in the terminal: banner, panels, colors, spinners, prompts and the interactive REPL.
version: 1
when_to_use: Use when the user wants the agent itself to look, feel or behave differently, or asks to change the chat interface.
tags: [tui ui design repl panel banner colors spinner terminal ux interface]
---
# Adjusting the carls-code interface

You are modifying your own user interface. The goal is a terminal UI that feels
crafted, not a default-looking CLI.

## Where each piece lives

| Piece | File |
| --- | --- |
| Banner, panels, tags, spinners | `src/cli/TerminalUI.ts` |
| REPL loop, prompt, interrupts | `src/cli/REPL.ts` |
| Raw key reader and line reader | `src/cli/Input.ts` |
| Streaming markdown renderer | `src/cli/Markdown.ts` |
| Model picker | `src/models/Selector.ts` |
| Slash commands | `src/cli/Commands.ts` |
| Argument parsing, help text | `src/cli/ArgsParser.ts` |

## Rules for a non-generic interface

1. Never print a bare list of lines when a bordered panel is clearer. Use
   `printPanel` and keep the box aligned to `process.stderr.columns`.
2. Strip ANSI codes before measuring width. Every visible-width calculation must
   go through a helper that removes `ESC [ ... m`, or boxes break.
3. Write chrome (banner, status, tool lines) to stderr and model output to
   stdout. This keeps `carls -p "..." | less` usable.
4. Guard every `"-".repeat(n)` with `Math.max(2, n)`. A negative count throws
   `RangeError: Invalid count value` and kills the process.
5. Use one palette: cyan for headings, gray for chrome, green for success,
   yellow for warnings, red for failures, magenta for effort badges.
6. One spinner implementation only. Stop the active spinner before printing.
7. Interactive selectors must take raw mode. Never attach a second `readline`
   while a selector is active, or keypresses are swallowed and the REPL exits.

## Verify

Run `npm run build`, then drive the REPL through a PTY and check the rendered
output. A plain `echo | carls` is not enough: it hides cursor and raw-mode bugs.
