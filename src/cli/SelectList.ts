import pc from "picocolors";
import { RawSession, type KeyEvent } from "./Input.js";
import { pad, terminalDimension, truncate, visibleWidth } from "./Text.js";

/** One selectable row. `section` groups it under a collapsible heading. */
export interface SelectItem {
  id: string;
  label: string;
  detail?: string;
  section?: string;
  /** Up to two extra lines shown under the list for the highlighted row. */
  preview?: string[];
}

export interface SelectListOptions {
  title: string;
  items: SelectItem[];
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Opens with this filter applied. */
  filter?: string;
  /** Row highlighted on open. Defaults to the first selectable row. */
  current?: string;
  /** Renders an extra line under the title, e.g. the effort ring. */
  status?: () => string;
  /** Extra footer hint for caller-specific bindings, e.g. "e effort". */
  extraHint?: string;
  /**
   * Handles a key before the built-in bindings. Return true to swallow it, so
   * callers can add bindings (the model picker uses this for effort).
   */
  onKey?: (key: KeyEvent) => boolean;
}

interface Row {
  kind: "section" | "item";
  section: string;
  item?: SelectItem;
  count?: number;
}

const ENTER_ALT = "\u001b[?1049h";
const LEAVE_ALT = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const HOME = "\u001b[H";
const CLEAR_BELOW = "\u001b[J";

/** Ranks a subsequence match; lower is better, undefined means no match. */
function fuzzyScore(query: string, haystack: string): number | undefined {
  if (query.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let index = 0;
  let score = 0;
  let last = -1;
  for (const char of query.toLowerCase()) {
    const found = hay.indexOf(char, index);
    if (found === -1) return undefined;
    if (last >= 0) score += found - last - 1;
    last = found;
    index = found + 1;
  }
  return score + Math.max(0, last - query.length);
}

/**
 * Full-screen list picker with grouping, collapsing and type-to-filter.
 *
 * It runs in the terminal's alternate screen buffer, so it never collides with
 * the REPL's scrolling region and leaves no half-drawn frames behind. Every row
 * is padded to exactly the terminal width, which is what stops the frame from
 * wrapping and corrupting itself.
 */
export async function selectList(options: SelectListOptions): Promise<SelectItem | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (input.isTTY !== true || output.isTTY !== true) return undefined;

  const sections: string[] = [];
  for (const item of options.items) {
    const name = item.section ?? "";
    if (!sections.includes(name)) sections.push(name);
  }

  let query = options.filter ?? "";
  const collapsed = new Set<string>();

  const filtered = (): SelectItem[] => {
    if (query.length === 0) return options.items;
    const scored: { item: SelectItem; score: number }[] = [];
    for (const item of options.items) {
      const haystack = `${item.section ?? ""} ${item.label} ${item.detail ?? ""}`;
      const score = fuzzyScore(query, haystack);
      if (score !== undefined) scored.push({ item, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((entry) => entry.item);
  };

  const buildRows = (): Row[] => {
    const items = filtered();
    const filtering = query.length > 0;
    const rows: Row[] = [];
    for (const section of sections) {
      const mine = items.filter((item) => (item.section ?? "") === section);
      if (mine.length === 0) continue;
      if (section.length > 0) {
        rows.push({ kind: "section", section, count: mine.length });
        if (!filtering && collapsed.has(section)) continue;
      }
      for (const item of mine) rows.push({ kind: "item", section, item });
    }
    return rows;
  };

  // One column is left free: writing to the very last cell of a row makes some
  // terminals wrap, which would push the frame down by a line.
  const size = (): { width: number; height: number } => ({
    width: Math.max(40, (terminalDimension(output.columns)) - 1),
    height: Math.max(10, terminalDimension(output.rows, 24)),
  });

  let rows = buildRows();
  let index = 0;
  let offset = 0;

  const firstSelectable = (): number => Math.max(0, rows.findIndex((row) => row.kind === "item"));
  if (options.current !== undefined) {
    const found = rows.findIndex((row) => row.item?.id === options.current);
    index = found >= 0 ? found : firstSelectable();
  } else {
    index = firstSelectable();
  }

  /** Fixed layout so the frame can never wrap: header, list, preview, footer. */
  const layout = (): { page: number; previewLines: number; headerLines: number } => {
    const { height } = size();
    const row = rows[index];
    const available = row?.kind === "item" ? (row.item?.preview?.length ?? 0) : 0;
    const previewLines = Math.min(2, available);
    const headerLines = options.status !== undefined ? 4 : 3;
    return { page: Math.max(3, height - headerLines - 1 - previewLines), previewLines, headerLines };
  };

  const clamp = (): void => {
    const { page } = layout();
    if (rows.length === 0) {
      index = 0;
      offset = 0;
      return;
    }
    index = Math.max(0, Math.min(index, rows.length - 1));
    if (index < offset) offset = index;
    if (index >= offset + page) offset = index - page + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - page)));
  };

  const frame = (): string[] => {
    const { width, height } = size();
    const { page, previewLines } = layout();
    const total = filtered().length;
    const lines: string[] = [];
    const title = `${pc.bold(pc.cyan(options.title))} ${pc.gray(`\u00b7 ${total} item${total === 1 ? "" : "s"}`)}`;
    lines.push(truncate(title, width));
    if (options.status !== undefined) lines.push(truncate(options.status(), width));
    const filterLine =
      query.length > 0
        ? `${pc.gray("filter")} ${pc.white(query)}${pc.gray("\u2588")}`
        : pc.gray("type to filter");
    lines.push(truncate(filterLine, width));
    lines.push(pc.gray("\u2500".repeat(width)));

    const slice = rows.slice(offset, offset + page);
    if (slice.length === 0) lines.push(pc.gray("  no matches"));
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      if (row === undefined) continue;
      const active = offset + i === index;
      const marker = active ? pc.cyan("\u25b8") : " ";
      if (row.kind === "section") {
        const open = query.length > 0 || !collapsed.has(row.section);
        const arrow = open ? "\u25be" : "\u25b8";
        lines.push(
          truncate(`${marker} ${arrow} ${pc.bold(row.section)} ${pc.gray(`(${row.count ?? 0})`)}`, width),
        );
        continue;
      }
      const item = row.item as SelectItem;
      const detail = item.detail !== undefined ? pc.gray(`  ${item.detail}`) : "";
      const room = Math.max(8, width - 3 - visibleWidth(detail));
      const label = active ? pc.white(item.label) : pc.gray(item.label);
      lines.push(truncate(`${marker} ${truncate(label, room)}${detail}`, width));
    }
    while (lines.length < height - 1 - previewLines) lines.push("");

    const selected = rows[index];
    const preview = selected?.kind === "item" ? (selected.item?.preview ?? []) : [];
    for (let i = 0; i < previewLines; i++) {
      lines.push(truncate(pc.gray(`  ${preview[i] ?? ""}`), width));
    }
    const position = rows.length > 0 ? `${index + 1}/${rows.length}` : "0/0";
    lines.push(
      truncate(
        pc.gray(
          [
            "\u2191\u2193 move",
            "\u2190\u2192 collapse",
            ...(options.extraHint !== undefined ? [options.extraHint] : []),
            "Enter open",
            "q cancel",
            position,
          ].join(" \u00b7 "),
        ),
        width,
      ),
    );
    return lines;
  };

  const draw = (): void => {
    clamp();
    const { width } = size();
    const body = frame()
      .map((line) => `\u001b[2K${pad(line, width)}`)
      .join("\r\n");
    output.write(`${HOME}${body}${CLEAR_BELOW}`);
  };

  const reset = (): void => {
    rows = buildRows();
    // Land on a real match, not the section heading above it, so Enter right
    // after typing opens the first result instead of toggling the group.
    const first = rows.findIndex((row) => row.kind === "item");
    index = first >= 0 ? first : 0;
    offset = 0;
  };

  const toggle = (section: string): void => {
    if (collapsed.has(section)) collapsed.delete(section);
    else collapsed.add(section);
    rows = buildRows();
    // The collapsed section keeps the cursor; the row it sat on may be gone.
    const found = rows.findIndex((row) => row.section === section);
    index = found >= 0 ? found : 0;
    offset = 0;
  };

  return RawSession.with(input, async (next) => {
    output.write(`${ENTER_ALT}${HIDE_CURSOR}`);
    try {
      draw();
      for (;;) {
        const key = await next();
        if (options.onKey?.(key) === true) {
          draw();
          continue;
        }
        const name = key.name ?? "";
        const { page } = layout();
        if (name === "up" || name === "k") index -= 1;
        else if (name === "down" || name === "j") index += 1;
        else if (name === "pageup") index -= page;
        else if (name === "pagedown") index += page;
        else if (name === "home") index = 0;
        else if (name === "end") index = rows.length - 1;
        else if (name === "left") {
          // Collapsing works from a heading or from any of its children, so the
          // arrow does not silently do nothing when the cursor is on an item.
          const row = rows[index];
          if (row !== undefined && !collapsed.has(row.section)) toggle(row.section);
        } else if (name === "right") {
          const row = rows[index];
          if (row !== undefined && collapsed.has(row.section)) toggle(row.section);
        } else if (name === "return" || name === "enter") {
          const row = rows[index];
          if (row?.kind === "section") toggle(row.section);
          else if (row?.item !== undefined) return row.item;
        } else if (name === "backspace") {
          if (query.length > 0) {
            query = query.slice(0, -1);
            reset();
          }
        } else if (name === "escape" || (key.ctrl === true && name === "c")) {
          return undefined;
        } else if (name === "q" && query.length === 0) {
          return undefined;
        } else if (key.ctrl === true && name === "u") {
          query = "";
          reset();
        } else if (key.ctrl !== true) {
          const char = key.sequence ?? "";
          if (char.length === 1 && char >= " " && char !== "\u007f") {
            query += char;
            reset();
          }
        }
        draw();
      }
    } finally {
      output.write(`${SHOW_CURSOR}${LEAVE_ALT}`);
    }
  });
}
