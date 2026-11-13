import { theme } from "./Theme.js";
import { formatDuration, pad, terminalDimension, truncate, visibleWidth } from "./Text.js";

/**
 * Grouped tool cards for the full-screen transcript.
 *
 * The agent explores a codebase with several read-only calls in one step
 * (`repo_map`, three `read_file`, a `grep_search`). Printing six separate boxes
 * for that buries the answer, so this module draws one compact tree per parallel
 * batch, the way a build log groups a stage.
 *
 * Two rules keep it honest:
 *
 * - Only read-only tools are groupable. A `bash` or an `edit_file` mutates the
 *   world, so it keeps its own card where a human will see it.
 * - Every line is fitted to the terminal width. A long path is truncated, never
 *   allowed to wrap, or the box drawing falls apart.
 */

/** Tools that can share a batch card: they observe, they do not mutate. */
const GROUPABLE = new Set([
  "read_file",
  "multi_read",
  "glob_files",
  "grep_search",
  "repo_map",
  "list_dir",
  "tree_view",
  "file_state",
]);

export function isGroupable(name: string): boolean {
  return GROUPABLE.has(name);
}

/** Compact right-column summary for a finished read-only call. */
export function toolSummary(name: string, durationMs: number, output?: string): string {
  const time = formatDuration(durationMs);
  if (output !== undefined) {
    if (name === "grep_search" || name === "glob_files") {
      const count = output.split("\n").filter((line) => line.trim().length > 0).length;
      return `${count} ${count === 1 ? "match" : "matches"} · ${time}`;
    }
    if (name === "read_file") {
      const lines = output.split("\n").length;
      return `${lines} lines · ${time}`;
    }
  }
  return time;
}

/**
 * Short left-column detail for a read-only call: the path for a read, the
 * pattern for a search. Mirrors what `ToolView` titles, but without the verb,
 * because the tree already carries the tool name in its own column.
 */
export function toolDetail(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {};
  const str = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  const short = (path: string): string => {
    const cwd = process.cwd();
    return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  };
  switch (name) {
    case "read_file": {
      const start = num("start_line");
      const end = num("end_line");
      const range = start !== undefined || end !== undefined ? ` (L${start ?? 1}-${end ?? ""})`.replace(/-\)$/, ")") : "";
      return `${short(str("path"))}${range}`;
    }
    case "multi_read": {
      const paths = record["paths"];
      return Array.isArray(paths) ? `${paths.length} files` : "";
    }
    case "grep_search":
      return `"${str("pattern")}"${str("path").length > 0 ? ` en ${short(str("path"))}` : ""}`;
    case "glob_files":
      return `"${str("pattern")}"${str("path").length > 0 ? ` en ${short(str("path"))}` : ""}`;
    case "list_dir":
    case "tree_view":
      return short(str("path") || ".");
    case "repo_map":
      return str("path").length > 0 ? short(str("path")) : ".";
    default:
      return str("path").length > 0 ? short(str("path")) : "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ToolEntryState = "running" | "ok" | "failed";

export interface ToolEntry {
  id: string;
  name: string;
  /** Short human title, e.g. `src/core/AgentLoop.ts (L1-120)`. */
  detail: string;
  /** Right-aligned metric, e.g. `45ms` or `142 símbolos`. */
  summary: string;
  state: ToolEntryState;
  durationMs?: number;
}

export interface ToolTreeOptions {
  /** Card title. Defaults to `Explorando workspace`. */
  title?: string;
  /** Total columns. Clamped to the terminal and a sane minimum. */
  width?: number;
  /** Rows shown before the card folds. Defaults to 3. */
  collapsedRows?: number;
  /** Show every row instead of the folded subset. */
  expanded?: boolean;
  /** Spinner glyph for the running state, supplied by the ticker. */
  spinner?: string;
}

const MIN_WIDTH = 24;
const CONNECTOR = { mid: "├─", last: "╰─" } as const;

function stateGlyph(state: ToolEntryState, spinner: string): string {
  const t = theme();
  if (state === "running") return t.paint(t.colors.accent, spinner);
  if (state === "ok") return t.paint(t.colors.feedback.success, "✓");
  return t.paint(t.colors.feedback.error, "✗");
}

/** Total wall time the batch has taken: finished work plus the live long pole. */
export function batchElapsedMs(entries: readonly ToolEntry[]): number {
  let done = 0;
  let running = 0;
  for (const entry of entries) {
    if (entry.state === "running") running = Math.max(running, entry.durationMs ?? 0);
    else done += entry.durationMs ?? 0;
  }
  return done + running;
}

function headerLine(entries: readonly ToolEntry[], title: string, width: number, spinner: string): string {
  const t = theme();
  const total = entries.length;
  const completed = entries.filter((entry) => entry.state !== "running").length;
  const glyph = completed < total ? spinner : "✓";
  const colour = completed < total ? t.colors.accent : t.colors.feedback.success;
  const elapsed = formatDuration(batchElapsedMs(entries));
  const label = `${t.paint(colour, glyph)} ${t.bold(title)} ${t.paint(t.colors.text.faint, `(${completed}/${total} completadas · ${elapsed})`)}`;
  const lead = t.paint(t.colors.border, "╭─ ");
  const tail = t.paint(t.colors.border, "╮");
  const fixed = 3 + 1;
  const fill = Math.max(1, width - fixed - visibleWidth(label));
  const dashes = t.paint(t.colors.border, ` ${"─".repeat(Math.max(0, fill - 1))}`);
  return `${lead}${label}${dashes}${tail}`;
}

function footerLine(width: number, hint?: string): string {
  const t = theme();
  if (hint === undefined || hint.length === 0) return t.paint(t.colors.border, `╰${"─".repeat(Math.max(2, width - 2))}╯`);
  // The corners cost three columns: `╰─` on the left and `╯` on the right.
  const inner = Math.max(2, width - 3);
  const text = ` ${hint} `;
  const dashes = Math.max(0, inner - visibleWidth(text));
  return `${t.paint(t.colors.border, "╰─")}${t.paint(t.colors.text.faint, text)}${t.paint(t.colors.border, `${"─".repeat(dashes)}╯`)}`;
}

function entryRow(entry: ToolEntry, isLast: boolean, width: number, spinner: string): string {
  const t = theme();
  const rail = t.paint(t.colors.border, "│");
  const connector = t.paint(t.colors.border, isLast ? CONNECTOR.last : CONNECTOR.mid);
  const glyph = stateGlyph(entry.state, spinner);
  const name = t.paint(t.colors.text.muted, entry.name);
  const detail = t.paint(t.colors.text.base, entry.detail);
  const summary = t.paint(t.colors.text.faint, entry.summary);
  // Inner budget: `│ ` prefix, ` │` suffix, and the `├─ ` connector.
  const inner = Math.max(1, width - 4);
  const head = `${connector} ${glyph} ${name}`;
  const headWidth = visibleWidth(head) + 1;
  const summaryWidth = visibleWidth(entry.summary);
  const detailBudget = Math.max(0, inner - headWidth - summaryWidth - 2);
  const detailText = detailBudget > 0 ? truncate(detail, detailBudget) : "";
  const gap = Math.max(1, inner - headWidth - visibleWidth(detailText) - summaryWidth);
  const body = `${head}${detailText.length > 0 ? ` ${detailText}` : ""}${" ".repeat(gap)}${summary}`;
  return `${rail} ${pad(body, inner)} ${rail}`;
}

/**
 * Renders a batch as a bordered tree. Folded by default: only `collapsedRows`
 * entries are shown and the footer carries the expand hint, so a ten-tool step
 * costs three rows instead of twelve. `expanded` shows everything.
 */
export function renderToolTree(entries: readonly ToolEntry[], options: ToolTreeOptions = {}): string[] {
  if (entries.length === 0) return [];
  const width = Math.max(MIN_WIDTH, Math.min(options.width ?? terminalDimension(undefined, 100), terminalDimension(undefined, 100)));
  const title = options.title ?? "Explorando workspace";
  const spinner = options.spinner ?? "⠋";
  const collapsedRows = Math.max(1, options.collapsedRows ?? 3);
  const expanded = options.expanded === true;
  const shown = expanded ? [...entries] : entries.slice(0, collapsedRows);
  const hidden = entries.length - shown.length;

  const lines: string[] = [headerLine(entries, title, width, spinner)];
  shown.forEach((entry, index) => {
    const isLast = index === shown.length - 1 && hidden === 0;
    lines.push(entryRow(entry, isLast, width, spinner));
  });
  if (hidden > 0) {
    const rail = theme().paint(theme().colors.border, "│");
    const more = `${CONNECTOR.last} ${theme().paint(theme().colors.text.faint, `+${hidden} más`)}`;
    lines.push(`${rail} ${pad(more, Math.max(1, width - 4))} ${rail}`);
  }
  const hint = hidden > 0 ? `[Ctrl+O expandir +${hidden}]` : expanded && entries.length > collapsedRows ? "[Ctrl+O plegar]" : undefined;
  lines.push(footerLine(width, hint));
  return lines;
}

/**
 * Mutable accumulator for one parallel step. The REPL feeds it `tool.start`
 * events, then patches each entry on `tool.done`, and re-renders the tree on
 * every animation frame while any entry is still running.
 */
export class ToolBatch {
  private readonly entries: ToolEntry[] = [];
  private expandedState = false;

  constructor(private readonly title: string = "Explorando workspace") {}

  add(entry: ToolEntry): void {
    this.entries.push(entry);
  }

  /** Patches a tracked entry when its result lands. */
  complete(id: string, state: Exclude<ToolEntryState, "running">, durationMs: number, summary?: string): boolean {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    entry.state = state;
    entry.durationMs = durationMs;
    if (summary !== undefined) entry.summary = summary;
    return true;
  }

  get size(): number {
    return this.entries.length;
  }

  get running(): number {
    return this.entries.filter((entry) => entry.state === "running").length;
  }

  get settled(): boolean {
    return this.running === 0;
  }

  get expanded(): boolean {
    return this.expandedState;
  }

  /** Flips the accordion and returns the new state. */
  toggle(): boolean {
    this.expandedState = !this.expandedState;
    return this.expandedState;
  }

  render(options: Omit<ToolTreeOptions, "title" | "expanded"> = {}): string[] {
    return renderToolTree(this.entries, { ...options, title: this.title, expanded: this.expandedState });
  }
}
