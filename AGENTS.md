# AGENTS.md

Instructions for the coding agent working in this repository. It is read into the
system prompt on every turn, so it is the cheapest way to change how the agent
behaves. Edit it to match your project.

Project internals live in `docs/` — do not paste them here:

- [docs/architecture.md](docs/architecture.md) — request lifecycle, compaction,
  sub-agents, interface invariants, module map
- [docs/configuration.md](docs/configuration.md) — every config key
- [docs/tools.md](docs/tools.md) — tool catalog
- [docs/cli.md](docs/cli.md) — flags, keybindings, commands
- [docs/parity.md](docs/parity.md) — what exists and what does not

## What this project is

`carls-code` is an autonomous coding agent that runs in a terminal: strict
TypeScript, native ESM, Node.js 20+. It gathers context, makes minimal edits,
then runs the project's own verification until it passes. There is no runtime
dependency on a framework — keep it that way.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit, strict + exactOptionalPropertyTypes
npm test            # vitest
npm run build       # tsc -> dist/
npm run dev         # run from source
node ./bin/carls.mjs --help   # requires npm run build first
```

## How to work in this repository

1. Read `docs/architecture.md` before changing `src/core/` or `src/cli/`.
2. Search before reading: `grep_search` and `glob_files` beat opening whole files.
3. Change the contract first (`src/types/`), then the implementations.
4. Never claim success without running `npm run typecheck && npm test`.
5. Finish with what you verified and what you could not verify.

## Non-negotiables

- **stdout is the model's answer.** Every diagnostic, spinner, tool stream and
  permission prompt goes to stderr, so `carls -p "…" | jq` keeps working.
- **Tools never throw.** Return `{ ok: false, error }`; `bash` reports a non-zero
  exit code as data.
- **Tool schemas come from zod**, never hand-written twice.
- **Compaction cuts at a tool-pair boundary.** A `tool_result` separated from its
  `tool_use` makes the provider reject the request.
- **Terminal width is a correctness property.** Measure with `src/cli/Text.ts`,
  never count escape sequences, and never emit a line wider than the terminal.
  `process.stderr.columns`/`.rows` are `0` on a pty with no window size set, and
  `0 ?? fallback` keeps the `0`, collapsing every layout to one ellipsis. Read
  them through `terminalDimension(...)`, never `?? fallback` directly.
- **File tools stay inside the workspace** unless `allowOutsideWorkspace` is set.
- **Line endings are data, not noise.** The model speaks LF; files may hold CRLF.
  Match on logical lines through `src/utils/eol.ts` (`splitLines`, `toLf`,
  `buildMatcher`) and write back the ending the file already used. Never normalise
  a whole file to LF on an edit, and never let a `\r` reach a rendered line or the
  model's context. A `split("\n")` on a CRLF file leaves a `\r` on every line and
  silently breaks `edit_file`, `apply_patch` and the terminal output.
- **No secrets in the repo.** Keys come from the environment or the config file,
  and `Logger.redact` runs before anything reaches a log or the model.

## Style

- Match the surrounding code; early returns over nesting.
- A comment explains *why*, never *what*.
- No new dependency without a strong reason; the tree is small on purpose.
- Tests live in `tests/smoke.test.ts` and exercise real code paths: real
  filesystem, real `bash`, a scripted in-process provider for `AgentLoop`.

## Testing the interactive chrome

Unit tests cannot see the terminal. To exercise the tab strip, the header and
the key handling for real, drive the built CLI over a pty:

```python
import os, pty, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.environ["ANTHROPIC_API_KEY"] = "test-key"
    os.execvp("node", ["node", "bin/carls.mjs"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
```

Point `baseUrl` in the config at a throwaway HTTP server that returns a canned
Anthropic message, so no network call is made. Set the window size in the
**parent** (the child's `fd` is `-1`); without it the pty reports `columns=0`
and every layout collapses. Write the raw bytes to a file and strip ANSI to read
the frames. `Ctrl+T` opens a tab, `Ctrl+X` closes one, `Ctrl+B` toggles the
sidebar, and `/tab list` prints the open tabs.

## Reinstalling on the development VM

The live install is a root-owned prefix, not a checkout: `/opt/carls/app` (the
built tree) with the launcher at `/opt/carls/bin/carls` and the config at
`/opt/carls/.carlsrc.json`, symlinked to `/etc/carls/.carlsrc.json`. To deploy a
new revision, ship the sources and run the repo's own installer so the layout
stays consistent:

```bash
git archive --format=tar.gz -o /tmp/carls-src.tgz HEAD   # or tar the worktree
scp -P 2222 /tmp/carls-src.tgz user@host:/tmp/
ssh -p 2222 user@host '
  set -e
  sudo cp -a /opt/carls/.carlsrc.json /tmp/carlsrc.snapshot.json
  rm -rf /tmp/carls-install && mkdir -p /tmp/carls-install
  tar xzf /tmp/carls-src.tgz -C /tmp/carls-install
  sudo rm -rf /opt/carls/app
  cd /tmp/carls-install
  sudo bash scripts/install.sh --yes --no-node --prefix /opt/carls
  sudo cp -a /tmp/carlsrc.snapshot.json /opt/carls/.carlsrc.json
  sudo chmod 644 /opt/carls/.carlsrc.json
  sudo ln -sf /opt/carls/.carlsrc.json /etc/carls/.carlsrc.json
  shred -u /tmp/carlsrc.snapshot.json
'
```

The snapshot exists because `install.sh` rewrites `/opt/carls/.carlsrc.json`
from the flags it was given, which would drop a provider key it cannot
rediscover. Afterwards check `carls --version` and a one-shot run
(`carls -p "reply OK" --yolo`).

Two notes from a real run of that block:

- The cleanup must be `sudo shred -u /tmp/carlsrc.snapshot.json`. `sudo cp -a`
  preserves the original root ownership, so a plain `shred` as the login user
  fails with `Permission denied`, and under `set -e` that aborts the deploy
  *after* the install has already succeeded — verify the dist tree before
  assuming the run failed.
- The provider key survives because of the snapshot, not because the installer
  is idempotent. Confirm `hasKey` is still true afterwards:
  `python3 -c 'import json;d=json.load(open("/opt/carls/.carlsrc.json"));print(bool(d.get("apiKey")))'`

## Definition of done

- `npm run typecheck` clean, `npm test` green, `npm run build` if `dist/` matters.
- New behaviour is covered by a test.
- Docs updated when a flag, config key or tool changes.
- Nothing committed that you would not want published.

## Pushing to `carlscodev` (sandbox caveat)

`carlscodev/carls-agent-v2` is the only repository this project pushes to, and
the local branch is `main`. The default credentials in this sandbox cannot
write:

- Both ambient GitHub credentials — `GITHUB_TOKEN` and the OpenHands git
  credential helper (`~/.openhands/git-credential-helper`) — authenticate as
  `BerunHaider`, which has **read-only** access to `carlscodev/carls-agent-v2`
  (`permissions.push: false`). A `git push` with them ends with
  `403 ... denied to BerunHaider`.

### Working write path: a `carlscodev` fine-grained PAT

A fine-grained PAT owned by `carlscodev` (`permissions.push: true`, verified)
pushes and opens PRs directly. Pass it inline on the push URL so it is never
written to `.git/config`:

```bash
git checkout -b feat/<slug>                       # never push to main directly
git push "https://carlscodev:${GH_PAT}@github.com/carlscodev/carls-agent-v2.git" feat/<slug>
```

Then open the PR with the REST API (`POST /repos/.../pulls`) using
`Authorization: Bearer $GH_PAT`. Keep the token out of the repo: never
`git remote set-url` with it, never echo it, never write it to a tracked file.

When no PAT is available, commit locally, deploy to the VM (see above) and
report the blocker. Do not retarget the remote at `BerunHaider`.

### CI does not run in this account

`Actions has been disabled for this user`, so no workflow ever fires on a push
or a pull request — the runs list stays empty. Verify locally instead:
`npm run typecheck && npm test && npm run build`. An empty CI section on a PR is
expected here, not a failure.

### Delegating through the OpenHands Cloud API

A delegated Cloud conversation runs inside a sandbox whose
`GITHUB_PERSONAL_ACCESS_TOKEN` *does* have write access to `carlscodev` (it
pushed `feat/phase8-cinematic-tui` and opened PR #2). Use this when the shell has
no PAT:

```bash
curl -s -X POST "https://app.all-hands.dev/api/v1/app-conversations" \
  -H "Authorization: Bearer $OPENHANDS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "initial_message": {"content": [{"type": "text", "text": "<self-contained task>"}]},
    "selected_repository": "carlscodev/carls-agent-v2",
    "selected_branch": "main",
    "llm_model": "openhands/deepseek-v4.1-flash"
  }'
```

Poll `GET /api/v1/app-conversations/start-tasks?ids=<start_task_id>` until
`READY` for the `app_conversation_id`, then watch `execution_status` and
`pr_number` on `GET /api/v1/app-conversations?ids=<id>`.

Two lessons from the first attempts: give the delegated agent the diff as a
downloadable URL and have it `curl` + `git apply` it — pasting a large base64
blob makes it try to recreate files with the file editor and fail. And run the
whole suite (`npm test`); the sandbox deny-list rejects the bare `rm -rf /`
pattern that a full `vitest run` output can trip, so scoping to the new test file
is a safe fallback.

### Merging a `carlscodev` PR from the sandbox

The fine-grained PAT can also merge. Prefer the async merge API over the
synchronous endpoint (it is the one that supports merge queues and stacked PRs):

```bash
curl -s -X PUT \
  "https://api.github.com/repos/carlscodev/carls-agent-v2/pulls/<n>/merge-async" \
  -H "Authorization: Bearer ${GH_PAT}" \
  -f merge_method=squash -f sha=<head_sha>
# 202 -> details.uuid; poll until status is no longer "pending"
curl -s "https://api.github.com/repos/carlscodev/carls-agent-v2/pulls/<n>/merge-async/<uuid>" \
  -H "Authorization: Bearer ${GH_PAT}"
```

Final `status` is `merged`, `enqueued` or `failed`. Then fast-forward the local
`main` (`git fetch origin main && git merge --ff-only origin/main`).

`gh` authenticates as `BerunHaider` (read-only here), so its API calls report
stale PR state — use `curl` with `${GH_PAT}` for anything on `carlscodev`.

### Block-4 MCP surface

`tests/mcp-config.test.ts` covers the MCP config/registry/wiring path that
`smoke.test.ts` only exercises at the transport level: `${ENV}` expansion,
`.carls/mcp.json` in both spellings, preset instantiation, `withoutMcp`, and
`Runtime.connectMcpServer`/`addMcpServer` against a fake stdio server.

Note when touching MCP tool names: they are namespaced per server
(`mcp__<server>__<tool>`), so two different servers never collide; the
duplicate-name skip in `registerMcpTools` only fires when the same server name
is connected twice.
