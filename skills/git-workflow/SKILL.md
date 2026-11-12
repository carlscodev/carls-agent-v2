---
name: git-workflow
description: Use Git well: commits, branches, rebases, conflict resolution, history recovery and bisecting.
version: 1
when_to_use: Use for any version-control task: committing, branching, merging, recovering lost work.
tags: [git commit branch rebase merge conflict bisect revert stash history]
---
# Git workflow

## Commits

- One logical change per commit; it should build and pass tests on its own.
- Imperative subject under 72 characters: "Add retry to the model client".
- Body explains *why*, not what the diff shows. Reference the issue.
- Never commit secrets, build output, editor files or large binaries. Check
  `.gitignore` first.

## Branches

- Short-lived branches off the default branch. Rebase onto the base before
  opening a pull request.
- Never force-push a shared branch. Force-push your own feature branch with
  `--force-with-lease` only.

## Rebase and merge

- `git rebase -i` to tidy your own commits before review: squash fixups, reword
  messages, reorder for readability.
- Resolve conflicts by understanding both sides. After a rebase, re-run the tests;
  a clean textual merge can still be semantically wrong.
- Prefer merge or squash according to the repository's convention; do not mix.

## Recovery

- `git reflog` finds commits after a bad reset or rebase. Almost nothing is lost
  for 30 days.
- `git revert` for a public commit; `git reset --hard` only on unpushed work.
- `git stash push -m "why"` with a message, and pop it soon.

## Investigation

- `git bisect run ./test.sh` finds the breaking commit automatically.
- `git log -S"symbol"` finds when a string appeared; `-G` for a regex.
- `git blame` for context, not for blame. Use `--ignore-rev` with a
  `.git-blame-ignore-revs` file for formatting commits.

## Safety

- `git status` and `git diff` before every commit.
- Never `git add -A` blindly in a repo with generated files.
- Do not rewrite history that others have based work on.
