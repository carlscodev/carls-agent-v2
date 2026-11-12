# Tools

Every tool has a zod schema, returns `{ ok, output, error? }` and never throws.
`read_file`, `multi_read`, `grep_search`, `glob_files` and `delegate_task` run in
parallel when the model asks for several in one turn; everything else runs alone
and in order. `⇉` marks the parallel-safe ones in `/tools`.

## Files

| Tool | What it does |
| --- | --- |
| `read_file` ⇉ | numbered lines, optional `start_line` / `end_line` |
| `multi_read` ⇉ | several files in one call, each bounded |
| `write_file` | atomic write (temp file + rename), snapshotted for `/undo` |
| `write_many` | several writes in one call |
| `edit_file` | exact-string replacement; rejects an ambiguous match |
| `apply_patch` | unified diff with context-line matching and fuzz |
| `file_append` | append without rewriting the file |
| `file_delete`, `file_move`, `file_copy`, `make_dir` | filesystem operations |
| `list_dir` ⇉, `tree_view` ⇉ | directory shape |
| `file_diff` ⇉ | unified diff between two files |
| `hash_file` ⇉, `base64_file` ⇉, `path_info` ⇉ | inspection helpers |

## Search

| Tool | What it does |
| --- | --- |
| `glob_files` ⇉ | glob with `.gitignore` respected |
| `repo_map` ⇉ | symbol and signature index for the workspace: `find` a name to see where it is declared and what depends on it, `budget_tokens` caps the rendered size. Cheaper than reading whole files before a change |
| `grep_search` ⇉ | JS regex over file contents: `pattern`, `glob`, `max_results`, `context` (0-5 surrounding lines), `case_sensitive` |
| `lsp` ⇉ | talks to the configured language server: `action: diagnostics` for errors, `hover` for the type/docs at a position, `definition` for where a symbol lives, `codeActions` for the quick fixes offered there |
| `lsp_edit` | applies a language-server edit: `action: rename` with `newName` renames the symbol across files, `action: codeAction` with the 1-based `index` applies one quick fix; `dryRun` reports the files instead of writing |

## Shell and system

| Tool | What it does |
| --- | --- |
| `bash` | runs a command with a timeout; exit code and duration come back as data |
| `process_list` | process table via `ps` / `tasklist` |
| `system_info` | OS, CPU, memory, disk |
| `env_get`, `env_set` | environment inspection and override |
| `sleep_wait` | bounded delay for polling |
| `clipboard_read`, `clipboard_write` | system clipboard |
| `computer_use` | keyboard and pointer input for a desktop session |

## Network and browser

| Tool | What it does |
| --- | --- |
| `web_fetch` ⇉ | fetch a URL and return readable text (scripts, styles and markup stripped) plus the title; `raw` for JSON |
| `web_search` ⇉ | keyless DuckDuckGo search: titles, URLs and snippets; `CARLS_SEARCH_ENDPOINT` points it at a mirror |
| `network_request` | HTTP with method, headers, body |
| `http_download` | stream a URL to a file |
| `browser_open`, `browser_text`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_eval`, `browser_close` | drive a headless page |

## Git

| Tool | What it does |
| --- | --- |
| `git_status`, `git_diff`, `git_log`, `git_blame`, `git_branch` | read-only inspection |
| `git_commit` | stage and commit, subject and body |
| `secret_scan` | flags credential-shaped strings before a commit |

## Agent

| Tool | What it does |
| --- | --- |
| `todo_write` | the plan the model keeps updated; `/todo` renders it |
| `delegate_task` ⇉ | isolated read-only sub-agents: one `goal` with a `role` (explorer/planner/auditor/tester), or a `tasks` array run in parallel, up to 6 per call |
| `use_skill` ⇉ | load a skill body by name |
| `save_skill` | write a project skill into `.agents/skills/<name>/SKILL.md` |
| `plan_task` | record a multi-step plan as a persistent task graph; survives a restart, replaces any previous plan |
| `advance_task` | move a node to `running`/`verifying`/`completed`/`failed`/`rolled_back`; a node must pass through `verifying` before `completed` |
| `read_task_graph` | show the active plan, the current node and the next one |
| `resume_task` | load a plan left behind by an earlier session and report where it stopped |
| `evolve_skill` | create or revise a skill through the curation gate; every accepted version is recorded |
| `review_skills` | list skills needing attention: flagged wrong, stale against a dependency, or never used |
| `skill_history` | show every recorded revision of a skill and its note |
| `revert_skill` | restore the previous revision of a skill |
| `skill_graph` | show the dependency graph declared through `requires`/`extends` |
| `mcp__<server>__<tool>` | whatever a connected MCP server exposes |

## Notes

- File tools are confined to `cwd` unless `allowOutsideWorkspace` is set; the
  check is lexical *and* symlink-aware.
- Shell output keeps its tail in the UI, because the failure is at the end.
- `bash` reports a non-zero exit code as data, never as a thrown error, so the
  model can read a failing test run and fix it.
