import pc from "picocolors";
import { splitLines } from "./eol.js";

export interface DiffLine {
  type: "add" | "remove" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Line-level diff via a longest-common-subsequence table. Adequate for the
 * file sizes an agent edits in a single tool call; not tuned for megabyte
 * files, where a Myers implementation would be preferable.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  // Compare logical lines: a trailing `\r` from a CRLF file would otherwise show
  // up inside every rendered line and misalign the terminal.
  const a = oldText.length === 0 ? [] : splitLines(oldText);
  const b = newText.length === 0 ? [] : splitLines(newText);

  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i];
      const nextRow = lcs[i + 1];
      if (row === undefined || nextRow === undefined) continue;
      const right = row[j + 1] ?? 0;
      const down = nextRow[j] ?? 0;
      const diag = nextRow[j + 1] ?? 0;
      row[j] = a[i] === b[j] ? diag + 1 : Math.max(right, down);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "context", text: a[i] ?? "", oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      result.push({ type: "remove", text: a[i] ?? "", oldLine: i + 1 });
      i++;
    } else {
      result.push({ type: "add", text: b[j] ?? "", newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", text: a[i] ?? "", oldLine: i + 1 });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: b[j] ?? "", newLine: j + 1 });
    j++;
  }
  return result;
}

export interface RenderOptions {
  /** Lines of unchanged context to keep around each change. */
  context?: number;
  /** Emit ANSI colors (disabled when piping to a non-tty). */
  color?: boolean;
}

export function renderDiff(
  oldText: string,
  newText: string,
  options: RenderOptions = {},
): string {
  const context = options.context ?? 3;
  const color = options.color ?? process.stdout.isTTY === true;
  const lines = diffLines(oldText, newText);

  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.type === "context") return;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const out: string[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {
      if (!skipping) {
        out.push(color ? pc.gray("  ...") : "  ...");
        skipping = true;
      }
      return;
    }
    skipping = false;
    if (line.type === "add") {
      out.push(color ? pc.green(`+ ${line.text}`) : `+ ${line.text}`);
    } else if (line.type === "remove") {
      out.push(color ? pc.red(`- ${line.text}`) : `- ${line.text}`);
    } else {
      out.push(color ? pc.gray(`  ${line.text}`) : `  ${line.text}`);
    }
  });

  return out.join("\n");
}

export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "remove") removed++;
  }
  return { added, removed };
}
