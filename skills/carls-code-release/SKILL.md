---
name: carls-code-release
description: Build, test, package and deploy carls-code, including the universal Linux installer and remote hosts.
version: 1
when_to_use: Use when shipping carls-code, cutting a version, or redeploying it to a server.
tags: [release build deploy installer package publish version ship npm]
---
# Releasing and deploying carls-code

## The gate

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc -> dist/
```

All three must pass. Never deploy a build that skipped the type checker.

## Bumping the version

Edit `version` in `package.json`. `--version` reads that file, so nothing else
needs changing.

## Universal install

`scripts/install.sh` handles any Linux, root or not:

- Detects the distribution and package manager, then installs Node (distro
  package, or the official static tarball when no package manager is usable).
- Builds from source when `src/` is present. The build needs `typescript`, so do
  not `npm install --omit=dev` before building.
- Writes the config via `dist/src/setup/writeConfig.js` and links the binary
  into `/usr/local/bin` or `~/.local/bin`.
- Writes `/etc/carls/.carlsrc.json` so every user on the box works with no setup.

Flags: `--yes`, `--prefix`, `--mode`, `--provider`, `--effort`, `--model`,
`--base-url`, `--api-key`, `--context-window`, `--no-node`, `--uninstall`.

## Remote redeploy

```bash
tar czf /tmp/carls-sync.tgz --exclude=node_modules --exclude=dist --exclude=.git carls-code
scp -P <port> /tmp/carls-sync.tgz user@host:/tmp/
ssh -p <port> user@host 'cd /tmp && rm -rf carls-code && tar xzf carls-sync.tgz'
```

Then rebuild on the host and copy `dist/` into the deployed app directory.

**Careful:** a fresh install rewrites the config and drops the API key. Back up
the deployed `.carlsrc.json` first, or pass the credentials back in.

## Post-deploy check

```bash
carls --version
printf '/status\n/exit\n' | carls
carls -p "crea un archivo hola.txt" --mode auto
```
