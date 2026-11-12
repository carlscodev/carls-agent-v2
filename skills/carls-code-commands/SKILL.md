---
name: carls-code-commands
description: Add or change a slash command in the carls-code REPL.
version: 1
when_to_use: Use when the user wants a new /command inside the chat, or wants an existing one to behave differently.
tags: [slash command repl cli add help interface]
---
# Adding a REPL command

Commands are data, not branches: append one entry to the `COMMANDS` array in
`src/cli/Commands.ts`.

```ts
{
  name: "/example",
  aliases: ["/ex"],              // optional
  usage: "/example <arg>",       // shown in /help
  summary: "One line for /help", // keep it under 60 characters
  run: async (args, ctx) => {
    // args is the tokenised remainder of the line, already split on spaces
    printPanel("Example", ["line one", "line two"]);
    return false; // return true only to exit the REPL
  },
}
```

## Rules

- `/help` renders from this array. Never hardcode a command in the help text.
- Return `true` only for commands that must end the session (`/exit`).
- Prefer `printPanel` / `printInfo` / `printError` from `TerminalUI.ts` over
  raw `console.log`, so styling stays consistent.
- Validate arguments and print `usage` on misuse. Do not throw.
- If the command needs runtime state, add a method to `Runtime` instead of
  reaching into internals from the command.
- Long-running commands should be cancellable with Ctrl+C.

## Test

Add the command name to the list asserted in `tests/smoke.test.ts` so it cannot
silently disappear from `/help`.
