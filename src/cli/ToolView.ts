import type { ToolResult } from "../types/tools.js";
import { folds } from "./Folds.js";
import { theme } from "./Theme.js";
import { visibleWidth, formatDuration } from "./Text.js";
import { splitLines } from "../utils/eol.js";

/**
 * Tool rendering, following opencode's vocabulary: a per-tool glyph, a short
 * title, and a bounded block body when the tool produced something worth
 * reading (a diff, file content, shell output, a todo list).
 *
 * Two rules drive the shape:
 *
 * - A start line is printed before execution only when the input itself is
 *   informative (`$ npm test`). For an edit or a write the interesting part is
 *   the result, so the start line is suppressed and the block stands alone.
 * - Every body is bounded. A shell command that prints 4000 lines must not push
 *   the conversation off screen, so overflow is truncated with a marker and the
 *   tail is preferred for command output, where the error lives.
 */

/** Glyphs, matching opencode so muscle memory carries over. */
const GLYPH = {
  read: "→",
  write: "←",
  edit: "←",
  glob: "✱",
  grep: "✱",
  shell: "$",
  todos: "#",
  subagent: "%",
  mcp: "⌁",
  default: "•",
  ok: "✓",
  fail: "✖",
} as const;

/** Per-tool body limits. Lines are cheap; characters are what wrap. */
const MAX_BODY_LINES = 16;
const MAX_BODY_CHARS = 2400;

/** Colour index per tool family, so related tools share a hue. */
const FAMILY: Record<string, number> = {
  read: 0,
  write: 1,
  edit: 1,
  glob: 2,
  grep: 2,
  shell: 3,
  todos: 4,
  subagent: 0,
};

function glyphFor(name: string): { glyph: string; family: number } {
  if (name === "read_file" || name === "multi_read") return { glyph: GLYPH.read, family: FAMILY.read ?? 0 };
  if (name === "write_file" || name === "write_many") return { glyph: GLYPH.write, family: FAMILY.write ?? 1 };
  if (name === "edit_file" || name === "apply_patch" || name === "file_append") {
    return { glyph: GLYPH.edit, family: FAMILY.edit ?? 1 };
  }
  if (name === "glob_files" || name === "tree_view" || name === "list_dir") {
    return { glyph: GLYPH.glob, family: FAMILY.glob ?? 2 };
  }
  if (name === "grep_search") return { glyph: GLYPH.grep, family: FAMILY.grep ?? 2 };
  if (name === "bash" || name === "process_list") return { glyph: GLYPH.shell, family: FAMILY.shell ?? 3 };
  if (name === "todo_write") return { glyph: GLYPH.todos, family: FAMILY.todos ?? 4 };
  if (name === "delegate_task" || name === "use_skill" || name === "save_skill") {
    return { glyph: GLYPH.subagent, family: FAMILY.subagent ?? 0 };
  }
  // Remote tools are namespaced mcp__<server>__<tool>; they get their own glyph
  // so a call reads as "that other server", not as an unknown tool.
  if (parseMcpName(name) !== undefined) return { glyph: GLYPH.mcp, family: FAMILY.grep ?? 2 };
  return { glyph: GLYPH.default, family: 0 };
}

/** Human title for a tool call, e.g. `Read src/index.ts:10-40`. */
function titleFor(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {};
  const str = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;

  switch (name) {
    case "read_file": {
      const start = num("start_line");
      const end = num("end_line");
      const range = start !== undefined || end !== undefined ? `:${start ?? 1}-${end ?? ""}`.replace(/-$/, "") : "";
      return `Read ${short(str("path"))}${range}`;
    }
    case "multi_read": {
      const paths = record["paths"];
      return `Read ${Array.isArray(paths) ? paths.length : 0} files`;
    }
    case "write_file":
      return `Write ${short(str("path"))}`;
    case "write_many": {
      const files = record["files"];
      return `Write ${Array.isArray(files) ? files.length : 0} files`;
    }
    case "edit_file":
      return `Edit ${short(str("path"))}`;
    case "apply_patch":
      return `Patch ${short(str("path"))}`;
    case "file_append":
      return `Append ${short(str("path"))}`;
    case "glob_files": {
      const pattern = str("pattern");
      const dir = str("path");
      return `Glob "${pattern}"${dir.length > 0 ? ` in ${short(dir)}` : ""}`;
    }
    case "grep_search": {
      const pattern = str("pattern");
      const include = str("include");
      const dir = str("path");
      const where = [dir.length > 0 ? short(dir) : "", include].filter((part) => part.length > 0).join(" ");
      return `Grep "${pattern}"${where.length > 0 ? ` in ${where}` : ""}`;
    }
    case "bash":
      return str("command").replace(/\s+/g, " ").trim();
    case "todo_write":
      return "Todos";
    case "delegate_task":
      return `Subagent ${truncate(str("goal"), 70)}`;
    case "use_skill":
      return `Skill ${str("name")}`;
    case "save_skill":
      return `Save skill ${str("name")}`;
    case "list_dir":
      return `List ${short(str("path") || ".")}`;
    case "tree_view":
      return `Tree ${short(str("path") || ".")}`;
    case "file_delete":
      return `Delete ${short(str("path"))}`;
    case "file_move":
    case "file_copy":
      return `${name === "file_move" ? "Move" : "Copy"} ${short(str("from"))} → ${short(str("to"))}`;
    case "make_dir":
      return `Mkdir ${short(str("path"))}`;
    case "git_commit":
      return `Commit ${truncate(str("message"), 60)}`;
    case "git_status":
      return "Git status";
    case "git_diff":
      return `Git diff${str("path").length > 0 ? ` ${short(str("path"))}` : ""}`;
    case "network_request":
      return `${str("method") || "GET"} ${truncate(str("url"), 70)}`;
    case "web_fetch":
      return `Fetch ${truncate(str("url"), 70)}`;
    case "web_search":
      return `Search ${truncate(str("query"), 60)}`;
    case "lsp":
      return `LSP ${str("action") || "diagnostics"} ${short(str("path"))}`;
    case "env_get":
      return `Env ${str("name") || str("prefix")}`;
    case "sleep_wait":
      return `Sleep ${num("seconds") ?? 0}s`;
    case "computer_use":
      return `Computer ${str("action")}${str("key").length > 0 ? ` ${str("key")}` : ""}`;
    default: {
      const mcp = parseMcpName(name);
      if (mcp !== undefined) return `MCP ${mcp.server} · ${mcp.tool}`;
      const json = JSON.stringify(input);
      return json === undefined || json === "{}" ? name : `${name} ${truncate(json, 70)}`;
    }
  }
}

/**
 * Tools whose start line is suppressed. The result carries the title instead, so
 * the user still learns which file changed; printing the input first would only
 * duplicate it.
 */
function defersTitle(name: string): boolean {
  return name === "write_file" || name === "edit_file" || name === "apply_patch" || name === "write_many";
}

/**
 * Short present-tense label for the footer's activity segment, e.g. `reading
 * src/index.ts` or `running npm test`. It reuses the same title the transcript
 * prints, lower-cased so the footer reads as a sentence next to the spinner.
 */
export function toolLabel(name: string, input: unknown = {}): string {
  const title = titleFor(name, input);
  // Tools whose title is already the argument, with no leading noun to drop.
  const bare: Record<string, string> = {
    bash: "running",
    network_request: "requesting",
    web_fetch: "fetching",
    web_search: "searching the web",
  };
  const barePrefix = bare[name];
  if (barePrefix !== undefined) {
    return title.length > 0 ? `${barePrefix} ${title}` : barePrefix;
  }
  const verb: Record<string, string> = {
    read_file: "reading",
    read_many: "reading",
    write_file: "writing",
    write_many: "writing",
    edit_file: "editing",
    apply_patch: "patching",
    file_append: "appending",
    glob_files: "finding files",
    grep_search: "searching",
    todo_write: "planning",
    delegate_task: "delegating",
    use_skill: "loading skill",
    save_skill: "saving skill",
    list_dir: "listing",
    tree_view: "listing",
    file_delete: "deleting",
    file_move: "moving",
    file_copy: "copying",
    make_dir: "creating",
    git_commit: "committing",
    git_status: "checking git",
    git_diff: "diffing",
    lsp: "asking the language server",
    env_get: "reading env",
    sleep_wait: "waiting",
  };
  const prefix = verb[name];
  if (prefix !== undefined) {
    // `titleFor` already carries the argument (the path, the command); the verb
    // replaces the leading noun so the footer reads "running npm test".
    const rest = title.replace(/^\S+\s*/, "");
    return rest.length > 0 ? `${prefix} ${rest}` : prefix;
  }
  const mcp = parseMcpName(name);
  if (mcp !== undefined) return `${mcp.server} · ${mcp.tool}`;
  return title;
}

/** The line printed before a tool runs, or "" when the input says nothing useful. */
export function toolCallLine(name: string, input: unknown): string {
  if (defersTitle(name)) return "";
  const t = theme();
  const { glyph, family } = glyphFor(name);
  const title = titleFor(name, input);
  if (name === "bash") return `${t.paint(t.colors.feedback.info, glyph)} ${t.bold(title)}`;
  return `${t.paint(t.categorical(family), glyph)} ${t.bold(title)}`;
}

/** The line (or block) printed once a tool returns. */
export function toolResultLine(name: string, result: ToolResult, durationMs?: number): string {
  const t = theme();
  const { family } = glyphFor(name);

  if (!result.ok) {
    const reason = (result.error ?? "failed").split("\n")[0] ?? "failed";
    const time = durationMs !== undefined ? ` ${t.paint(t.colors.text.faint, `· ${formatDuration(durationMs)}`)}` : "";
    return `${t.paint(t.colors.feedback.error, GLYPH.fail)} ${t.paint(t.colors.text.muted, truncate(reason, 110))}${time}`;
  }

  const body = toolBody(name, result);
  const summary = resultSummary(name, result);

  // A suppressed start line means the title was never shown, so it leads the
  // result: without it the block reads as an anonymous diff.
  const lead =
    defersTitle(name)
      ? `${t.paint(t.categorical(family), glyphFor(name).glyph)} ${t.bold(titleFor(name, result.metadata?.path !== undefined ? { path: result.metadata.path } : {}))} `
      : "";

  // Every call reports how long it took, so a slow tool is visible even when it
  // prints nothing. Shell already carries its own timing in the summary.
  const time =
    durationMs !== undefined && name !== "bash"
      ? ` ${t.paint(t.colors.text.faint, `· ${formatDuration(durationMs)}`)}`
      : "";

  const head =
    summary.length > 0
      ? `${lead}${t.paint(t.colors.feedback.success, GLYPH.ok)} ${t.paint(t.colors.text.muted, summary)}${time}`
      : name === "bash"
        ? ""
        : `${lead}${t.paint(t.colors.feedback.success, GLYPH.ok)}${time}`;
  if (body === undefined) return head;

  // The body is printed truncated; keep the whole thing so Ctrl+O can expand it.
  const raw = fullBody(name, result);
  let hint = "";
  if (raw !== undefined && wasTruncated(name, result)) {
    const fold = folds().add(name, titleFor(name, result.metadata?.path !== undefined ? { path: result.metadata.path } : {}), raw);
    hint = `\n${t.paint(t.colors.text.faint, `  ⌄ ctrl+o expands (${raw.split("\n").length} lines · #${fold.id})`)}`;
  }
  return head.length > 0 ? `${head}\n${body}${hint}` : `${body}${hint}`;
}

/** The complete, unpainted body for a tool, or undefined when there is none. */
function fullBody(name: string, result: ToolResult): string | undefined {
  const meta = result.metadata ?? {};
  if (name === "edit_file" || name === "apply_patch") {
    const diff = meta["diff"];
    return typeof diff === "string" && diff.trim().length > 0 ? diff : undefined;
  }
  if (name === "write_file" && typeof meta["content"] === "string") return meta["content"] as string;
  if (name === "bash") {
    const output = result.output.trim();
    return output.length > 0 ? output : undefined;
  }
  if (name === "todo_write") {
    const todos = meta["todos"];
    return Array.isArray(todos) ? JSON.stringify(todos, null, 2) : undefined;
  }
  return undefined;
}

/** True when the rendered block dropped lines the full body still holds. */
function wasTruncated(name: string, result: ToolResult): boolean {
  const raw = fullBody(name, result);
  if (raw === undefined) return false;
  return raw.split("\n").length > MAX_BODY_LINES || raw.length > MAX_BODY_CHARS;
}

/** A bounded block body for tools whose output is worth reading. */
function toolBody(name: string, result: ToolResult): string | undefined {
  const meta = result.metadata ?? {};

  if (name === "edit_file" || name === "apply_patch") {
    const diff = meta["diff"];
    if (typeof diff === "string" && diff.trim().length > 0) return renderUnifiedDiff(diff);
    return undefined;
  }

  if (name === "write_file" && typeof meta["content"] === "string") {
    return renderCodeBlock(meta["content"] as string);
  }

  if (name === "bash") {
    const output = result.output.trim();
    if (output.length === 0) return undefined;
    // Command output keeps its tail: the failure is at the end, not the start.
    return renderShellOutput(output);
  }

  if (name === "todo_write") {
    const todos = meta["todos"];
    if (Array.isArray(todos)) return renderTodos(todos);
    return undefined;
  }

  return undefined;
}

function resultSummary(name: string, result: ToolResult): string {
  const meta = result.metadata ?? {};
  switch (name) {
    case "read_file": {
      const total = meta["lines"];
      const shown = meta["shown"];
      if (typeof total === "number" && typeof shown === "number" && shown < total) {
        return `${shown} of ${total} lines`;
      }
      if (typeof total === "number") return `${total} lines`;
      return `${result.output.split("\n").length} lines`;
    }
    case "write_file": {
      const bytes = meta["bytes"];
      return typeof bytes === "number" ? `${bytes} bytes written` : "written";
    }
    case "edit_file": {
      const added = meta["added"];
      const removed = meta["removed"];
      const t = theme();
      const counts =
        typeof added === "number" && typeof removed === "number"
          ? `${t.paint(t.colors.diff.added, `+${added}`)} ${t.paint(t.colors.diff.removed, `-${removed}`)}`
          : "";
      const replacements = meta["replacements"];
      const label =
        typeof replacements === "number" && replacements > 1 ? ` · ${replacements} replacements` : "";
      return `${counts}${label}`.trim();
    }
    case "bash": {
      const code = meta["exitCode"];
      const ms = meta["durationMs"];
      const t = theme();
      const exit =
        typeof code === "number"
          ? code === 0
            ? t.paint(t.colors.feedback.success, "exit 0")
            : t.paint(t.colors.feedback.error, `exit ${code}`)
          : "";
      const time = typeof ms === "number" ? t.paint(t.colors.text.faint, formatDuration(ms)) : "";
      return ["shell completed", exit, time].filter((part) => part.length > 0).join(" · ");
    }
    case "glob_files":
    case "grep_search": {
      const count = countMatches(result.output);
      return `${count} ${count === 1 ? "match" : "matches"}`;
    }
    case "todo_write": {
      const todos = meta["todos"];
      if (Array.isArray(todos)) return `${todos.length} todos`;
      return "todos updated";
    }
    default:
      return "";
  }
}

function countMatches(output: string): number {
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Colours a unified diff. Hunk headers, additions and removals each get their
 * own token so the eye can separate "where" from "what".
 */
export function renderUnifiedDiff(diff: string): string {
  const t = theme();
  const lines = diff.split("\n");
  const shown = lines.slice(0, MAX_BODY_LINES);
  const out = shown.map((line) => {
    if (line.startsWith("@@")) return t.paint(t.colors.diff.hunkHeader, line);
    if (line.startsWith("+++") || line.startsWith("---")) return t.paint(t.colors.text.faint, line);
    if (line.startsWith("+")) return t.paint(t.colors.diff.added, line);
    if (line.startsWith("-")) return t.paint(t.colors.diff.removed, line);
    return t.paint(t.colors.diff.context, line);
  });
  return indent(ellipsize(out, lines.length, diff));
}

/** Renders file content as a code block. */
function renderCodeBlock(content: string): string {
  const t = theme();
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_BODY_LINES).map((line) => t.paint(t.colors.markdown.code, line));
  return indent(ellipsize(shown, lines.length, content));
}

/** Shell output keeps its tail, since that is where a failure is reported. */
function renderShellOutput(output: string): string {
  const t = theme();
  // Split on any ending: a `\r` from a Windows command would return the cursor to
  // column 0 and overwrite the line on screen.
  const lines = splitLines(output);
  const budget = MAX_BODY_LINES;
  const tail = lines.length > budget ? lines.slice(-budget) : lines;
  const dropped = lines.length - tail.length;
  const painted = tail.map((line) => t.paint(t.colors.text.muted, line));
  if (dropped > 0) {
    painted.unshift(t.paint(t.colors.text.faint, `… ${dropped} earlier ${dropped === 1 ? "line" : "lines"}`));
  }
  return indent(ellipsize(painted, 0, output));
}

/** Todo list with opencode's status markers. */
function renderTodos(todos: unknown[]): string {
  const t = theme();
  const rows: string[] = [];
  for (const entry of todos.slice(0, MAX_BODY_LINES)) {
    if (!isRecord(entry)) continue;
    const content = typeof entry["content"] === "string" ? (entry["content"] as string) : "";
    const status = typeof entry["status"] === "string" ? (entry["status"] as string) : "pending";
    if (status === "completed") {
      rows.push(`${t.paint(t.colors.feedback.success, "[✓]")} ${t.paint(t.colors.text.faint, t.strike(content))}`);
    } else if (status === "in_progress") {
      rows.push(`${t.paint(t.colors.feedback.info, "[•]")} ${t.paint(t.colors.text.base, content)}`);
    } else if (status === "cancelled") {
      rows.push(`${t.paint(t.colors.text.faint, "[-]")} ${t.paint(t.colors.text.faint, content)}`);
    } else {
      rows.push(`${t.paint(t.colors.text.muted, "[ ]")} ${t.paint(t.colors.text.muted, content)}`);
    }
  }
  if (todos.length > MAX_BODY_LINES) {
    rows.push(t.paint(t.colors.text.faint, `… ${todos.length - MAX_BODY_LINES} more`));
  }
  return indent(rows);
}

/**
 * Hangs a block off a left rule so it reads as one card belonging to the call
 * line above it, the way a diff in a review tool does.
 */
function indent(lines: string[]): string {
  const rule = theme().paint(theme().colors.border, "┃");
  return lines.map((line) => `${rule} ${line}`).join("\n");
}

/** Appends an overflow marker and hard-cuts if the block is still too wide. */
function ellipsize(lines: string[], total: number, raw: string): string[] {
  void raw;
  const out = [...lines];
  if (total > out.length) out.push(theme().paint(theme().colors.text.faint, `… ${total - out.length} more lines`));
  const joined = out.join("\n");
  if (visibleWidth(joined) <= MAX_BODY_CHARS) return out;
  const kept: string[] = [];
  let used = 0;
  for (const line of out) {
    const width = visibleWidth(line);
    if (used + width > MAX_BODY_CHARS) break;
    kept.push(line);
    used += width + 1;
  }
  kept.push(theme().paint(theme().colors.text.faint, "… truncated"));
  return kept;
}

/** Splits `mcp__server__tool` into its parts; undefined for a local tool. */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) return undefined;
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function short(path: string): string {
  if (path.length === 0) return "";
  const cwd = process.cwd();
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}
