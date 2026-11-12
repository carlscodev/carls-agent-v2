---
name: shell-bash
description: Write safe, portable shell scripts: quoting, error handling, traps and POSIX vs bash.
version: 1
when_to_use: Use for .sh scripts, installers, CI steps or any command line automation.
tags: [bash shell posix script quoting trap pipefail portable sh]
---
# Shell scripting

## The safety header

```bash
#!/usr/bin/env bash
set -o pipefail
# set -e only when you understand every command's exit status
```

Do not add `set -u` blindly to a script that reads optional variables; use
`${VAR:-}` instead. `set -e` is disabled inside `if`, `&&`, `||` and `!`, which
surprises people.

## Quoting

- Quote every expansion: `"$var"`, `"$(cmd)"`, `"${array[@]}"`.
- `"$@"` passes arguments correctly; `$*` does not. Always `"$@"`.
- Use `[ ]` for POSIX tests, `[[ ]]` in bash for pattern matching and no word
  splitting.
- Never `eval` on anything containing input.

## Robustness

- Clean up with `trap 'rm -f "$tmp"' EXIT INT TERM`.
- `mktemp -d` for temp dirs; never a fixed path in `/tmp`.
- Check prerequisites up front: `command -v curl >/dev/null || die "curl missing"`.
- Report failures on stderr and exit non-zero: `die() { echo "$*" >&2; exit 1; }`.
- Log the failing command and the last lines of its output, not just "failed".

## Portability

- `/bin/sh` is dash on Debian: no `[[ ]]`, no arrays, no `local` in some shells,
  no `echo -e`. If you need them, require bash in the shebang and check for it.
- `readlink -f`, `sed -i` and `date -d` differ across platforms. Avoid or guard.
- Prefer `printf` over `echo` for anything with backslashes or leading dashes.

## Testing

- `shellcheck` in CI, no exceptions. It catches most of the above.
- Test with `bash -n` for syntax and a dry-run flag for behavior.
- Drive interactive scripts with a PTY in tests; piping hides prompt bugs.
