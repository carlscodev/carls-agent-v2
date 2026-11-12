/**
 * ANSI-aware text measurement and slicing.
 *
 * Every layout bug in this CLI traces back to counting escape sequences as
 * printable characters, so width, padding and truncation all live here and are
 * the only place that parses SGR sequences.
 */

const SGR = /\u001b\[[0-9;]*m/g;

/** Marks the start of a wide (two-column) character. */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
  );
}

/** Printable width of `text`, ignoring SGR escapes and counting wide glyphs as 2. */
export function visibleWidth(text: string): number {
  const plain = text.replace(SGR, "");
  let width = 0;
  for (const char of plain) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Cuts `text` to at most `width` printable columns, appending `ellipsis` when
 * something was dropped. SGR sequences are preserved and a reset is appended
 * if the cut left a style open.
 */
export function truncate(text: string, width: number, ellipsis = "\u2026"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const budget = Math.max(0, width - visibleWidth(ellipsis));
  let out = "";
  let used = 0;
  let open = false;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end === -1) break;
      const sequence = text.slice(index, end + 1);
      out += sequence;
      open = sequence !== "\u001b[0m";
      index = end + 1;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const size = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + size > budget) break;
    out += char;
    used += size;
    index += char.length;
  }
  return `${out}${ellipsis}${open ? "\u001b[0m" : ""}`;
}

/** Pads `text` with spaces to exactly `width` columns, truncating if needed. */
export function pad(text: string, width: number): string {
  const fitted = visibleWidth(text) > width ? truncate(text, width) : text;
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

/**
 * Greedy word wrap to `width` columns. Words longer than the width are hard-cut
 * so a single long token can never overflow the line.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (visibleWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = visibleWidth(word) > width ? truncate(word, width) : word;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Clamps a width to the terminal, keeping a sane minimum for tiny windows. */
export function clampWidth(columns: number | undefined, fallback: number, minimum = 20): number {
  const width = columns ?? fallback;
  return Math.max(minimum, width);
}
