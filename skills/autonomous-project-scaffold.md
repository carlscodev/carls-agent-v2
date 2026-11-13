---
name: autonomous-project-scaffold
description: Take a project from an empty folder to a verified, runnable application on disk: inspect, plan, scaffold, install, build, test and hand off.
version: 1
when_to_use: Use when the operator asks to create a complete project, app, website, game or service and expects real files, not a code block in the chat.
tags: [project scaffold create build setup install verify compile runnable architecture plan task disk autonomous proyecto proyectos crear construir levantar desde cero aplicacion app] 
---
# Autonomous project scaffold

## Rule zero

A project request is an execution request. Create the files on disk with
`write_file` / `edit_file`, install what is needed and run the build. A final
answer that is only a fenced code block is a failure of the contract.

## 1. Inspect before writing

- `glob_files` the current directory and `repo_map` the workspace. Reuse an
  existing package manager, framework and style if the repository already has
  one; do not introduce a second stack for the same job.
- Read `package.json`, the lockfile, `tsconfig.json` and the existing entry point.

## 2. Plan the nodes

Call `plan_task` with concrete nodes and acceptance criteria:

1. Base architecture: folder layout, package manifest, config, entry point.
2. Core behaviour: the smallest vertical slice that proves the product works.
3. Interface: layout, design tokens, responsive states, empty/error/loading.
4. Verification: typecheck, build, tests, a real run of the product.
5. Handoff: README with exact install, run and test commands.

Mark a node `completed` only after its verification command has run.

## 3. Scaffold on disk

- Create the manifest with explicit scripts: `dev`, `build`, `test`,
  `typecheck` and `lint` when the tool exists.
- Pin the runtime contract in `engines` when the project depends on it.
- Add `.gitignore`, `.editorconfig`, `.env.example` and a `README.md` from the
  start. Never commit a real secret.
- Prefer the platform's native tooling over a global dependency. A project that
  needs `npm install -g` to build is not finished.

## 4. Install and verify

Run the install, then the real checks:

```bash
npm install
npm run typecheck
npm test
npm run build
```

If a command fails, read the actual error and fix the cause. A red build is an
unfinished node, not a note to add to the handoff. When there is no test
framework, add one or write a small deterministic check rather than claiming
the code works.

## 5. Quality bar

- No placeholders, no `// TODO`, no empty components, no commented-out code.
- Every page or screen handles loading, empty, error and success.
- UI follows the `modern-web-glassmorphism` skill when it is a web product and
  `tactical-3d-web-game` when it is a game. No emoji in the interface.
- Files names and symbols describe intent; a new reader can navigate the project
  without a map.

## 6. Handoff

Finish with a short executive summary: what was built, the files that matter,
the exact commands to run it, and anything that is genuinely blocked. Do not
paste the implementation into the chat; it is already on disk.
