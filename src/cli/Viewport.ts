import { visibleWidth } from "./Text.js";

/**
 * Virtual scrollback for the full-screen TUI.
 *
 * Alternate-screen terminals have no native scrollback, so the conversation is
 * kept here as logical lines and only the visible window is painted at fixed
 * rows. Scrolling changes `scrollOffset`, never the header, composer or footer
 * coordinates. Wrapping happens once per append at the current content width;
 * a resize reflows the retained raw lines.
 */

export interface ViewportOptions {
  width?: number;
  height?: number;
  /** Hard cap on retained lines; the oldest are dropped first. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 20_000;

export class Viewport {
  private rawLines: string[] = [];
  private wrappedLines: string[] = [];
  private pending = "";
  /** Rows above the live edge; 0 means follow new output. */
  private offset = 0;
  private autoStick = true;
  private unread = 0;
  private width: number;
  private height: number;
  private readonly maxLines: number;

  constructor(options: ViewportOptions = {}) {
    this.width = Math.max(1, options.width ?? 80);
    this.height = Math.max(1, options.height ?? 20);
    this.maxLines = Math.max(100, options.maxLines ?? DEFAULT_MAX_LINES);
  }

  get lineCount(): number {
    return this.wrappedLines.length;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  get unreadCount(): number {
    return this.unread;
  }

  get atBottom(): boolean {
    return this.offset === 0;
  }

  get widthColumns(): number {
    return this.width;
  }

  get heightRows(): number {
    return this.height;
  }

  /** Lines waiting for their terminating newline. */
  get pendingText(): string {
    return this.pending;
  }

  setSize(width: number, height: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (nextWidth !== this.width) {
      this.width = nextWidth;
      this.reflow();
    }
    this.height = nextHeight;
    this.clampOffset();
  }

  /** Appends arbitrary terminal text; incomplete trailing text is retained. */
  append(text: string): void {
    if (text.length === 0) return;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.pending += normalized;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const part of parts) this.pushRaw(part);
    // A very long line without a newline is wrapped as it grows so the buffer
    // cannot grow without bound on a minified file or a progress line.
    if (visibleWidth(this.pending) >= this.width * 4) {
      const wrapped = wrapViewportLine(this.pending, this.width);
      const tail = wrapped.pop() ?? "";
      for (const line of wrapped) this.pushRaw(line);
      this.pending = tail;
    }
    this.updateUnread();
  }

  /** Emits a held partial line as a complete row. */
  flushPending(): void {
    if (this.pending.length === 0) return;
    this.pushRaw(this.pending);
    this.pending = "";
    this.updateUnread();
  }

  /** Appends complete lines, used by rich block renderers. */
  appendLines(lines: readonly string[]): void {
    this.flushPending();
    for (const line of lines) this.pushRaw(line);
    this.updateUnread();
  }

  clear(): void {
    this.rawLines = [];
    this.wrappedLines = [];
    this.pending = "";
    this.offset = 0;
    this.autoStick = true;
    this.unread = 0;
  }

  /** Visible rows, top to bottom, at most `height`. No padding is added. */
  visible(height: number = this.height): string[] {
    const rows = Math.max(1, height);
    const end = Math.max(0, this.wrappedLines.length - this.offset);
    const start = Math.max(0, end - rows);
    return this.wrappedLines.slice(start, end);
  }

  scrollUp(rows = 1): void {
    const max = Math.max(0, this.wrappedLines.length - this.height);
    this.offset = Math.min(max, this.offset + Math.max(0, rows));
    this.autoStick = this.offset === 0;
    if (this.autoStick) this.unread = 0;
    this.clampOffset();
  }

  scrollDown(rows = 1): void {
    this.offset = Math.max(0, this.offset - Math.max(0, rows));
    this.autoStick = this.offset === 0;
    if (this.autoStick) this.unread = 0;
  }

  pageUp(pageSize: number = this.height): void {
    this.scrollUp(Math.max(1, pageSize));
  }

  pageDown(pageSize: number = this.height): void {
    this.scrollDown(Math.max(1, pageSize));
  }

  toTop(): void {
    this.offset = Math.max(0, this.wrappedLines.length - this.height);
    this.autoStick = this.offset === 0;
  }

  toBottom(): void {
    this.offset = 0;
    this.autoStick = true;
    this.unread = 0;
  }

  /** One column per row: `│` for the track, `█` for the thumb. */
  scrollbar(height: number = this.height): string[] {
    const rows = Math.max(1, height);
    const total = this.wrappedLines.length;
    if (total <= rows) return Array.from({ length: rows }, () => "│");
    const thumb = Math.max(1, Math.floor((rows * rows) / total));
    const maxOffset = Math.max(1, total - rows);
    const position = Math.min(1, Math.max(0, this.offset / maxOffset));
    const top = Math.round((1 - position) * (rows - thumb));
    return Array.from({ length: rows }, (_value, index) =>
      index >= top && index < top + thumb ? "█" : "│",
    );
  }

  /** Live-edge hint shown while the viewport is detached from new output. */
  pill(): string | undefined {
    if (this.offset === 0) return undefined;
    const count = this.unread > 0 ? `${this.unread} new` : "history";
    return `[ ↓ ${count} · End to jump to live ]`;
  }

  private pushRaw(line: string): void {
    const normalized = line.replace(/\t/g, "  ");
    this.rawLines.push(normalized);
    this.wrappedLines.push(...wrapViewportLine(normalized, this.width));
    this.trim();
    if (this.autoStick) this.offset = 0;
  }

  private reflow(): void {
    this.wrappedLines = [];
    for (const line of this.rawLines) {
      this.wrappedLines.push(...wrapViewportLine(line, this.width));
    }
    this.clampOffset();
  }

  private trim(): void {
    if (this.rawLines.length <= this.maxLines) return;
    const excess = this.rawLines.length - this.maxLines;
    this.rawLines.splice(0, excess);
    this.reflow();
    this.offset = Math.max(0, this.offset - excess);
  }

  private updateUnread(): void {
    if (this.autoStick) {
      this.offset = 0;
      this.unread = 0;
      return;
    }
    this.unread += 1;
  }

  private clampOffset(): void {
    this.offset = Math.min(this.offset, Math.max(0, this.wrappedLines.length - this.height));
    if (this.offset === 0) {
      this.autoStick = true;
      this.unread = 0;
    }
  }
}

/**
 * Word-wrap with a hard split for tokens wider than the viewport. The shared
 * `wrap` truncates a long token, which is fine for a status line but loses
 * conversation text in a scrollback; this variant keeps every character.
 */
function wrapViewportLine(text: string, width: number): string[] {
  if (text.length === 0) return [""];
  if (visibleWidth(text) <= width) return [text];
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (visibleWidth(word) > width) {
      if (line.length > 0) {
        lines.push(line);
        line = "";
      }
      const chunks = chunkAnsi(word, width);
      const tail = chunks.pop() ?? "";
      lines.push(...chunks);
      line = tail;
      continue;
    }
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (visibleWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = word;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

/** Splits ANSI-coloured text into chunks of at most `width` visible columns. */
function chunkAnsi(text: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let used = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end === -1) break;
      chunk += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const size = visibleWidth(char);
    if (used + size > width && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      used = 0;
    }
    chunk += char;
    used += size;
    index += char.length;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.length > 0 ? chunks : [""];
}
