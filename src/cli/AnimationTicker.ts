/**
 * Continuous animation clock for the busy TUI.
 *
 * A working agent must never look frozen while waiting for the first token or a
 * slow tool. This ticker is the only timer that drives spinner glyphs, live
 * elapsed clocks and pulse frames. It is deliberately tiny: one interval while
 * busy, zero timers and zero CPU once the turn ends.
 */

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const PULSE_FRAMES = ["░", "▒", "▓", "█", "▓", "▒"] as const;

export interface TickerFrame {
  /** Zero-based tick number since start(). */
  tick: number;
  spinner: string;
  pulse: string;
  elapsedMs: number;
  /** `0.1s`, `2.4s`, `1m02s` — a live clock with tenths under a minute. */
  elapsed: string;
}

export class AnimationTicker {
  private timer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private tick = 0;
  private frames = 0;

  constructor(
    private readonly onFrame: (frame: TickerFrame) => void,
    private readonly intervalMs = 80,
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  get frameCount(): number {
    return this.frames;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.startedAt = Date.now();
    this.tick = 0;
    this.emit();
    this.timer = setInterval(() => {
      this.tick += 1;
      this.emit();
    }, Math.max(1, this.intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One frame for tests and synchronous redraws. */
  emit(): TickerFrame {
    const elapsedMs = Math.max(0, Date.now() - this.startedAt);
    const frame: TickerFrame = {
      tick: this.tick,
      spinner: SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length] ?? "⠋",
      pulse: PULSE_FRAMES[this.tick % PULSE_FRAMES.length] ?? "░",
      elapsedMs,
      elapsed: formatElapsed(elapsedMs),
    };
    this.frames += 1;
    this.onFrame(frame);
    return frame;
  }
}

export function formatElapsed(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}s`;
  const totalSeconds = Math.floor(totalTenths / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
