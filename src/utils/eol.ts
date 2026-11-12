/**
 * Line-ending handling.
 *
 * The model works in `\n`, always: its context, its diffs and its tool calls are
 * LF. Real files are not so consistent. A file saved on Windows holds `\r\n`, and
 * a repository can mix the two. Without normalising, `old_string` never matches a
 * CRLF file and every multi-line edit fails on Windows.
 *
 * The rule here: match on logical lines, but write the file back with the line
 * ending it already used. Editing a CRLF file must not silently convert it to LF
 * and produce a whole-file diff.
 */

export type Eol = "\n" | "\r\n";

export interface EolInfo {
  /** The ending to write back. `\n` when the file is empty or has none. */
  eol: Eol;
  /** True when at least one `\r\n` was found. */
  crlf: boolean;
  /** True when at least one bare `\n` (not part of a `\r\n`) was found. */
  lf: boolean;
  /** True when the file mixes `\r\n` and bare `\n`. */
  mixed: boolean;
}

/** Inspects a file's text without changing it. */
export function detectEol(text: string): EolInfo {
  const crlf = text.includes("\r\n");
  // A bare LF is one not preceded by CR.
  const lf = /(^|[^\r])\n/.test(text);
  return {
    eol: crlf ? "\r\n" : "\n",
    crlf,
    lf,
    mixed: crlf && lf,
  };
}

/**
 * Splits on any line ending, so `a\r\nb\nc` becomes `["a", "b", "c"]`. Used when
 * the line ending does not matter, only the logical lines do: reading, grepping
 * and applying hunks all work this way.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** Normalises every line ending to `\n`, for matching and diffing. */
export function toLf(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/** Rewrites `\n` in `text` to `eol`. The inverse of `toLf` for one line ending. */
export function applyEol(text: string, eol: Eol): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

/**
 * Normalises a patch to LF before parsing. A diff produced on Windows carries
 * `\r\n`, which would leave a stray `\r` on every context line and make the hunk
 * fail to match.
 */
export function normalizePatch(patch: string): string {
  return toLf(patch);
}
