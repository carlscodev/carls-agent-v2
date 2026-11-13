import { mixRgb, theme } from "./Theme.js";

/**
 * Token-to-screen interpolation for the interactive TUI.
 *
 * A model delivers network chunks in irregular bursts: nothing for 400 ms, then
 * 300 characters at once. Piping that straight to the terminal makes the answer
 * appear in lurches, which reads as stutter. This class buffers the incoming
 * deltas and drains them on a fixed 16 ms frame, so text flows at a steady pace
 * while never falling more than one burst behind the network.
 *
 * The drain rate is adaptive: a small backlog writes a couple of characters per
 * frame for a typing effect, while a large one drains a quarter of the buffer so
 * a fast model is not artificially slowed. `flushInstant` empties everything at
 * a turn boundary or before a tool block, where a smooth tail would only delay
 * the next thing the user needs to see.
 */

/** One frame at 60 Hz. */
export const FRAME_MS = 16;
/** Backlog at or below this drains at `MIN_DRAIN` characters per frame. */
const SMALL_BACKLOG = 40;
/** Backlog above this drains as a fraction of the buffer instead of a fixed count. */
const LARGE_BACKLOG = 150;
/** Characters per frame for a small backlog: a visible but brisk typewriter. */
const MIN_DRAIN = 2;
/** Characters per frame for a small backlog once the buffer is mid-sized. */
const MAX_SMALL_DRAIN = 4;
/** Fraction of the backlog drained per frame when it is large. */
const LARGE_DRAIN_RATIO = 0.25;

export interface SmoothStreamOptions {
  /** Called once per frame with the characters to append. */
  onDrain: (text: string) => void;
  /** Frame period in milliseconds. Defaults to `FRAME_MS` (60 fps). */
  intervalMs?: number;
  /**
   * When false, `push` forwards immediately and no timer is ever created. This
   * is the non-TTY / `-p` path: stdout stays byte-for-byte clean.
   */
  smooth?: boolean;
}

/** Number of characters to release for a backlog of `pending` characters. */
export function drainBudget(pending: number): number {
  if (pending <= 0) return 0;
  if (pending > LARGE_BACKLOG) return Math.max(MIN_DRAIN, Math.ceil(pending * LARGE_DRAIN_RATIO));
  if (pending <= SMALL_BACKLOG) return Math.min(pending, MIN_DRAIN);
  // Mid-sized backlog: ramp linearly so the hand-off to the large regime is not
  // a visible jump in speed.
  const span = LARGE_BACKLOG - SMALL_BACKLOG;
  const ratio = (pending - SMALL_BACKLOG) / span;
  return Math.max(MIN_DRAIN, Math.round(MIN_DRAIN + ratio * (MAX_SMALL_DRAIN - MIN_DRAIN)));
}

export class SmoothStreamRenderer {
  private readonly onDrain: (text: string) => void;
  private readonly intervalMs: number;
  private readonly smooth: boolean;
  private buffer = "";
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: SmoothStreamOptions) {
    this.onDrain = options.onDrain;
    this.intervalMs = Math.max(1, options.intervalMs ?? FRAME_MS);
    this.smooth = options.smooth !== false;
  }

  /** Characters queued but not yet released to the sink. */
  get pending(): number {
    return this.buffer.length;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Queues a network chunk. Unsmooth mode forwards it on the spot. */
  push(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    if (!this.smooth) {
      this.onDrain(chunk);
      return;
    }
    this.buffer += chunk;
    this.schedule();
  }

  /**
   * Releases everything buffered right now and stops the clock. Called at a turn
   * boundary or before a tool block, where a smooth tail would only make the
   * next thing the user needs to see arrive later.
   */
  flushInstant(): void {
    this.stopTimer();
    if (this.buffer.length === 0) return;
    const text = this.buffer;
    this.buffer = "";
    this.onDrain(text);
  }

  dispose(): void {
    this.stopTimer();
    this.buffer = "";
    this.disposed = true;
  }

  /** Releases exactly one frame's worth. Exposed for deterministic tests. */
  tick(): void {
    if (this.buffer.length === 0) {
      this.stopTimer();
      return;
    }
    const take = drainBudget(this.buffer.length);
    if (take <= 0) return;
    const text = this.buffer.slice(0, take);
    this.buffer = this.buffer.slice(take);
    this.onDrain(text);
    if (this.buffer.length === 0) this.stopTimer();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
      if (this.buffer.length > 0) this.schedule();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The blinking block cursor appended to the line still being written. */
export const STREAM_CURSOR = "▍";

/**
 * A half-block cursor whose luminance breathes between the neon accent and a
 * dim mint. Pure in `tick`, so a test can assert the exact glyph without a
 * clock. Returns `undefined` when nothing is streaming, which is what makes the
 * cursor vanish the instant the message ends.
 */
export function streamCursor(tick: number, streaming: boolean): string | undefined {
  if (!streaming) return undefined;
  const t = theme();
  // A slow triangle wave: 24 frames up, 24 down, so it reads as a breath rather
  // than a strobe.
  const phase = ((tick % 48) + 48) % 48;
  const ratio = phase < 24 ? phase / 24 : (48 - phase) / 24;
  const dim = t.colors.text.faint;
  return t.paint(mixRgb(dim, t.colors.accent, ratio), STREAM_CURSOR);
}
