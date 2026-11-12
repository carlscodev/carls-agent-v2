---
name: tui-design-patterns
description: Design rules for terminal interfaces: layout, color, width handling, spinners, prompts and accessibility.
version: 1
when_to_use: Use when building or refining any CLI or TUI, including carls-code's own interface.
tags: [tui terminal cli layout ansi color spinner prompt box unicode accessibility]
---
# Terminal interface patterns

## Layout

- Reserve a content width and never exceed it. Read `process.stdout.columns`,
  fall back to 80, and clamp between 46 and 100.
- Measure width after stripping ANSI escapes. Always.
- Boxes: `+--+ | | +--+` or the rounded variants. Align the right border with
  padding computed from visible width, and guard every repeat with
  `Math.max(2, n)`.
- Two spaces of left padding inside boxes reads better than one.
- Never wrap long paths; middle-truncate them (`/opt/.../dist/src/index.js`).

## Color

- Respect `NO_COLOR` and non-TTY output. When either applies, emit plain text.
- Chrome gray, headings cyan, success green, warning yellow, failure red. One
  accent for state (magenta for mode/effort) and nothing else.
- Never encode meaning in color alone: pair it with a glyph or a word.

## Motion

- One spinner, owned by one place. Stop it before writing any other line.
- Spinner frames on an 80ms timer; clear the line before the next frame.
- No animation in non-TTY mode.

## Interaction

- Raw mode only while a selector is active, and always restore the previous mode
  in a `finally`.
- Support arrow keys and vim keys for movement, left/right for cycling, Enter to
  accept, `q`/Esc to cancel, and Ctrl+C to abort. Document the keys on screen.
- The prompt must survive pasting and history: use a real line editor, not a
  character-by-character reader.
- Double Ctrl+C to exit; single Ctrl+C aborts the current turn.

## Content

- Report token and cost figures in tabular form so digits line up.
- Show relative paths when inside the workspace, absolute when outside.
- Error messages: what failed, on what, and the next command to try.
