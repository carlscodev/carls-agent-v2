/**
 * Terminal frame rendering primitives.
 *
 * Two independent problems live here:
 *
 * 1. A full-screen-ish TUI redraws the same rows many times per second. Writing
 *    them unconditionally wastes PTY bandwidth and, worse, lets the terminal
 *    show a half-updated frame. `FrameRenderer` keeps the previous frame, emits
 *    only the rows that changed, and wraps the whole update in DEC Mode 2026
 *    (`\x1b[?2026h` … `\x1b[?2026l`) so the terminal applies it atomically.
 *
 * 2. A streaming model can emit hundreds of tiny deltas per second. Rendering
 *    each one costs more than the model call itself. `FrameCoalescer` batches
 *    them on a 16 ms budget, which is one frame at 60 Hz: visually immediate,
 *    but bounded.
 */

const BEGIN_SYNC = "\u001b[?2026h";
const END_SYNC = "\u001b[?2026l";
const ESC = "\u001b[";
const DEFAULT_INTERVAL_MS = 16;

export interface FrameRendererOptions {
  /** Coalescing window. 16 ms is 60 fps; 0 renders synchronously. */
  intervalMs?: number;
  /** Wrap updates in Mode 2026 when the output is a TTY. */
  synchronized?: boolean;
  /** Delay writes to the next tick instead of writing immediately. */
  coalesce?: boolean;
}

export interface RenderFrameOptions {
  /** 1-based terminal row for the first line of the frame. */
  originRow?: number;
}

/**
 * Double-buffered, diffing frame writer.
 *
 * The renderer only owns the rows it is given. A caller that moves the frame
 * (a menu growing upward, for example) must call `reset()` first: the previous
 * buffer cannot know where the old rows were, and guessing would erase the
 * wrong ones.
 */
export class FrameRenderer {
  private readonly out: NodeJS.WriteStream;
  private readonly intervalMs: number;
  private readonly synchronized: boolean;
  private readonly coalesce: boolean;
  private previous: string[] = [];
  private pending: string[] | undefined;
  private originRow = 1;
  private lastOriginRow = 1;
  private timer: NodeJS.Timeout | undefined;
  private frames = 0;
  private writes = 0;
  private disposed = false;

  constructor(out: NodeJS.WriteStream = process.stderr, options: FrameRendererOptions = {}) {
    this.out = out;
    this.intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.synchronized = options.synchronized !== false;
    this.coalesce = options.coalesce === true;
  }

  /** Number of frames actually written (a no-op diff does not count). */
  get frameCount(): number {
    return this.frames;
  }

  /** Number of `write` calls issued, used by tests to prove coalescing. */
  get writeCount(): number {
    return this.writes;
  }

  get lastFrame(): readonly string[] {
    return this.previous;
  }

  get pendingFrame(): readonly string[] | undefined {
    return this.pending;
  }

  /**
   * Queues a frame. With `coalesce` enabled, calls within the interval collapse
   * into one write carrying the latest frame; otherwise it is written now.
   */
  render(lines: readonly string[], options: RenderFrameOptions = {}): void {
    if (this.disposed) return;
    this.pending = [...lines];
    if (options.originRow !== undefined) this.originRow = Math.max(1, Math.round(options.originRow));
    if (!this.coalesce || this.out.isTTY !== true) {
      this.flush();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Writes the pending frame immediately. */
  flush(): void {
    if (this.disposed) return;
    const next = this.pending;
    if (next === undefined) return;
    this.pending = undefined;

    if (this.out.isTTY !== true) {
      // A pipe has no cursor to position and no flicker to hide. Emit plain
      // text only when it changed, so redirecting a chatty session stays sane.
      if (!sameLines(this.previous, next)) {
        this.write(`${next.join("\n")}${next.length > 0 ? "\n" : ""}`);
        this.previous = next;
        this.frames++;
      }
      this.lastOriginRow = this.originRow;
      return;
    }

    // A new origin means the previous buffer describes different rows; clearing
    // them here would erase whatever the caller already repainted there.
    if (this.originRow !== this.lastOriginRow) {
      this.previous = [];
      this.lastOriginRow = this.originRow;
    }

    const writes: string[] = [];
    const rows = Math.max(this.previous.length, next.length);
    for (let index = 0; index < rows; index++) {
      const before = this.previous[index];
      const after = next[index];
      if (before === after) continue;
      const row = this.originRow + index;
      if (after === undefined) {
        writes.push(`${ESC}${row};1H${ESC}2K`);
      } else {
        writes.push(`${ESC}${row};1H${ESC}2K${after}`);
      }
    }

    if (writes.length === 0) {
      this.previous = next;
      return;
    }
    const body = writes.join("");
    this.write(this.synchronized ? `${BEGIN_SYNC}${body}${END_SYNC}` : body);
    this.previous = next;
    this.frames++;
  }

  /** Erases the rows of the last written frame. */
  clear(): void {
    if (this.disposed) return;
    if (this.out.isTTY !== true) {
      this.previous = [];
      return;
    }
    if (this.previous.length === 0) return;
    const writes = this.previous.map((_line, index) => `${ESC}${this.originRow + index};1H${ESC}2K`);
    this.write(this.synchronized ? `${BEGIN_SYNC}${writes.join("")}${END_SYNC}` : writes.join(""));
    this.previous = [];
  }

  /** Forgets the previous frame without writing, after an external repaint. */
  reset(): void {
    this.previous = [];
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
    this.disposed = true;
  }

  private write(text: string): void {
    this.out.write(text);
    this.writes++;
  }
}

/**
 * Batches streaming chunks on a fixed interval.
 *
 * The callback receives one concatenated string, so the markdown renderer and
 * the reasoning writer do their per-chunk work once per frame instead of once
 * per token. `flush` is safe to call at a tool boundary or at the end of a turn.
 */
export class FrameCoalescer {
  private chunks: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly onFlush: (text: string) => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  /** Chunks waiting for the next frame. */
  get pending(): number {
    return this.chunks.length;
  }

  push(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    this.chunks.push(chunk);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, Math.max(0, this.intervalMs));
    this.timer.unref?.();
  }

  /** Emits everything buffered right now. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.chunks.length === 0) return;
    const text = this.chunks.join("");
    this.chunks = [];
    this.onFlush(text);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.chunks = [];
    this.disposed = true;
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
