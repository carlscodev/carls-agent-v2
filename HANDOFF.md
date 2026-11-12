# Handoff

State of `carls-code` and everything the next session needs to keep going. The
project-level rules live in [AGENTS.md](AGENTS.md); this file is the session
report.

## Where things are

| | |
| --- | --- |
| Repository | `https://github.com/BerunHaider/carls-agent-v2` (branch `main`) |
| Local branch | `freebuff/07a410415a017967652d4d91` |
| Remote to push to | `mine` — `git push mine HEAD:main` (`cloud_git push` still points at the old `carlscodev` repo) |
| Version | `0.2.0` |
| Checks | `npm run typecheck` → clean, `npm test` → 170/170, `npm run build` → clean |

`npx convex …` and `npx convex login` are never used here; the project has no
Convex backend.

## What this session added

| Commit | Change |
| --- | --- |
| `53e0468` | Agent-preset `permission:` blocks (`edit`, `webfetch`, bash patterns) folded into `permissions.toolAllow` / `toolDeny` / `allow` / `deny`; prompt queue (`src/cli/Queue.ts`) for messages typed during a turn |
| `25ed980` | Real steering: `Runtime.steer()` + `AgentLoopDeps.takeSteering()` fold a typed message into the running turn at the next step boundary; late steers fall back to the queue; approvals pause the composer so a `y` cannot also steer |
| `8d3968f` | Plugin-style hooks: `tool.execute.before` (veto **and** input rewrite, revalidated by `tool.parse`), `tool.execute.after` (observation override), `session.idle` (fires from `Runtime.runTurn`); dotted config names accepted alongside camelCase |
| this one | husky pre-commit (`typecheck` + `test`), LSP code actions and `lsp_edit` (rename + quick fix, multi-file `WorkspaceEdit`, `dryRun`) |

Earlier sessions added: `/redo`, `/export`, `/editor`, `lsp`, `web_fetch` /
`web_search` with an SSRF guard, `@file` mentions, custom agents, auto-update,
the CI/release workflows and the offline onboarding mode.

## How the pieces fit

- `src/cli/REPL.ts` — prompt loop, `runGoal` (composer + steering + queue drain),
  footer (`statusLine`, `↑n queued`), Chrome vs inline rendering.
- `src/cli/Queue.ts` — `PromptQueue`, `drainQueue`, `collectTypedLines`
  (returns `{stop, pause, resume}`; Enter steers via `onSubmit`, falls back to
  the queue without it, Ctrl+C re-raises SIGINT because raw mode eats it).
- `src/core/AgentLoop.ts` — step loop; steering is injected **before** each
  model call, never between a `tool_use` and its `tool_result`; before/after
  hooks wrap `executeTool`.
- `src/core/Hooks.ts` — shell hooks. `toolBefore` chains `preToolUse` then
  `tool.execute.before`; `toolAfter` chains `postToolUse` then
  `tool.execute.after`; `sessionIdle` is called by `Runtime.runTurn`.
- `src/security/PermissionGate.ts` — `toolDeny` first, then `toolAllow`, then
  command patterns and the mode; `yolo` overrides everything.
- `src/agents/Presets.ts` — frontmatter parser (no YAML dependency):
  `splitFrontmatter` → `parsePermission` → `foldPermission`.
- `src/lsp/` — `Client.ts` (framing, hover, definition, diagnostics, code
  actions, rename), `Edits.ts` (UTF-16 offsets, back-to-front application,
  `planWorkspaceEdit`). `src/tools/Lsp.ts` reads, `src/tools/LspEdit.ts` writes.

## Verification recipes

- Unit/integration: `npm test` — `tests/smoke.test.ts` uses a real filesystem,
  real `bash`, a scripted in-process provider for `AgentLoop`, and a fake
  language server written to a temp file.
- Real terminal: `artifacts/pty-queue.mjs` and `artifacts/pty-approval.mjs`
  drive the built CLI through `script -qec` (a pty) against a stub OpenAI
  server. Run `npm run build` first, then `node artifacts/pty-queue.mjs`. They
  are intentionally untracked (a pty test in CI is fragile) — keep or delete
  them, they are not part of the build.
- Commit gate: husky runs `npm run typecheck && npm test` from
  `.husky/pre-commit`; `git commit --no-verify` skips it. `"prepare": "husky ||
  true"` keeps tarball installs (which have no `.git`) working.

## Known limits and blockers

- **GitHub Actions cannot run here**: disabled on `carlscodev/carls-agent-v2`,
  and `BerunHaider` returns "The job was not started because your account is
  locked due to a billing issue". The workflows are committed but unverified on
  a real runner.
- **No Chrome-mode visual check**: no TTY for the fixed-layout UI, so
  `chrome.writeRegion` output (steering line, queued footer) is only verified
  through the non-Chrome path and the pty runs.
- `api.github.com` rate-limits the sandbox IP (403 unauthenticated); `gh` is
  authenticated as `BerunHaider` with `repo,workflow` scopes.
- Tests that talk to a local server need `CARLS_ALLOW_LOCAL_FETCH=1`.
- 52 tools are registered; `carls --doctor` and docs should keep saying 52.

## Next steps, in the order the parity list has them

1. **Session tabs and a sidebar** — the largest remaining gap; it changes
   `src/cli/Chrome.ts` (fixed header, region, status) and the REPL's session
   state. Opencode uses `Ctrl+Tab` / `Ctrl+X W`; we currently run one session on
   screen.
2. **Headless server + remote client** — `Runtime` is embeddable and every
   renderer is separate from the loop, so an HTTP/WS transport is mostly wiring
   plus auth.
3. **Custom keybinds and per-project TUI config** — `src/cli/Input.ts` and the
   palette read a fixed keymap today.
4. **Share links** — `/export` writes markdown locally; a hosted URL needs a
   backend and a redaction pass over the transcript.
5. **In-process plugins** — hooks already carry the plugin API's events,
   payloads and JSON contract; what is missing is loading JS modules into the
   runtime and a plugin manifest.

## Rules that bite if forgotten

- stdout is the model's answer; every diagnostic goes to stderr.
- Tools never throw; they return `{ ok: false, error }`.
- Compaction must cut at a tool-pair boundary; steering follows the same rule.
- File access goes through `guardPath`; a rewritten hook input and a
  `WorkspaceEdit` are re-validated the same way.
- Terminal width is correctness — measure with `src/cli/Text.ts`.
- No secrets in the repo, ever.
