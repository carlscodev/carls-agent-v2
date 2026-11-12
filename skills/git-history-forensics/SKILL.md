---
name: git-history-forensics
description: Investigate history: find when and why a line changed, who to ask, and what a release contained.
version: 1
when_to_use: Use when debugging a regression, finding the origin of a change, or preparing release notes.
tags: [git blame log bisect history forensics regression release notes archaeology]
---
# History forensics

## Find the change

- `git log -S"<string>"` finds commits that added or removed that string.
  `git log -G"<regex>"` matches the diff text.
- `git log -L :functionName:path/to/file` follows a function across its history.
- `git blame -w -C path` ignores whitespace and follows moved code across files,
  so you blame the real author of the logic.

## Find the regression

- `git bisect start; git bisect bad; git bisect good <tag>` then
  `git bisect run ./test.sh` to automate. It needs a script that exits non-zero
  on failure.
- Before bisecting, write the failing check as a command. Guessing inside a
  bisect wastes the whole run.

## Understand the why

- Read the commit message and the linked issue, not just the diff. A change that
  looks wrong often fixes something else.
- `git log --oneline --graph --decorate -20` for the shape of recent history.
- `git show <sha> --stat` to see the blast radius before reading the diff.

## Release notes

- `git log --oneline <last-tag>..HEAD` is the raw material.
- Group by type (features, fixes, breaking changes), not by commit order. A
  breaking change leads the notes.
- Mention the migration step for anything that changes a config, a schema or a
  public API.

## Reporting

State the commit that introduced the behaviour, the commit that last changed it,
and the evidence (the exact command and its output). A forensic claim without a
command is a guess.
