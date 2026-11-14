import { theme } from "./Theme.js";
import type { Rgb } from "./Theme.js";
import type { ManagedProcess } from "../core/ProcessSentinel.js";

/**
 * High-density micro-meters for the tactical footer.
 *
 * A percentage tells the user a number; a six-cell bar tells them at a glance
 * whether they are close to the edge. These helpers render the compact HUD
 * widgets — an eighth-block meter and a token-rate sparkline — and keep every
 * string inside the column budget they are given, because a footer that wraps is
 * worse than no footer.
 */

/** Left-to-right ramp of eighth blocks, index 0..8. */
export const EIGHTH_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

/** Single-row sparkline ramp, index 0..7. */
export const SPARKLINE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Green under 60%, amber to 80%, coral above. */
export function meterColour(ratio: number): Rgb {
  const t = theme();
  if (ratio > 0.8) return t.colors.feedback.error;
  if (ratio >= 0.6) return t.colors.feedback.warning;
  return t.colors.accent;
}

/**
 * Renders `cells` cells of eighth-resolution fill for `ratio`, e.g.
 * `██▋░░░` at 42% over six cells. Pure and width-exact: the result always
 * occupies exactly `cells` columns, so it can be concatenated without measuring.
 */
export function renderMeter(ratio: number, cells = 6): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const totalEighths = Math.round(clamped * cells * 8);
  const full = Math.floor(totalEighths / 8);
  const remainder = totalEighths % 8;
  const colour = meterColour(clamped);
  const t = theme();
  const empty = t.colors.text.faint;
  let out = "";
  for (let index = 0; index < cells; index++) {
    if (index < full) {
      out += t.paint(colour, "█");
    } else if (index === full && remainder > 0) {
      out += t.paint(colour, EIGHTH_BLOCKS[remainder] ?? "");
    } else {
      out += t.paint(empty, "░");
    }
  }
  return out;
}

/** `CTX:[██▋░░░] 42%` — the context-pressure cell of the footer. */
export function renderContextCell(ratio: number, cells = 6, detail?: string): string {
  const t = theme();
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const colour = meterColour(ratio);
  const suffix = detail !== undefined && detail.length > 0 ? ` ${t.paint(t.colors.text.faint, detail)}` : "";
  return `${t.paint(t.colors.text.faint, "CTX:")}${t.paint(t.colors.border, "[")}${renderMeter(ratio, cells)}${t.paint(t.colors.border, "]")} ${t.paint(colour, `${percent}%`)}${suffix}`;
}

/**
 * A five-cell sparkline for a series of token rates. The series is resampled to
 * `cells` values, scaled against its own maximum, and drawn on the ramp. A flat
 * or empty series yields the floor glyph rather than a misleading spike.
 */
export function renderSparkline(values: readonly number[], cells = 5): string {
  const t = theme();
  const colour = t.colors.accent;
  if (values.length === 0) return t.paint(colour, SPARKLINE_BLOCKS[0] ?? "▁").repeat(cells);
  const sampled = resample(values, cells);
  const peak = Math.max(...sampled, 1);
  return sampled
    .map((value) => {
      const level = Math.max(0, Math.min(SPARKLINE_BLOCKS.length - 1, Math.round((value / peak) * (SPARKLINE_BLOCKS.length - 1))));
      return t.paint(colour, SPARKLINE_BLOCKS[level] ?? "▁");
    })
    .join("");
}

/** `tok/s ▁▃▅▇▄` — the streaming-rate cell of the footer. */
export function renderRateCell(values: readonly number[], cells = 5): string {
  const t = theme();
  const latest = values.length > 0 ? Math.round(values[values.length - 1] ?? 0) : 0;
  return `${t.paint(t.colors.text.faint, "tok/s")} ${renderSparkline(values, cells)} ${t.paint(t.colors.feedback.success, `${latest}`)}`;
}

/**
 * Resamples `values` to exactly `cells` entries by averaging contiguous buckets.
 * Downsampling keeps the shape of a burst instead of dropping it, which is what
 * makes the sparkline readable at five columns.
 */
export function resample(values: readonly number[], cells: number): number[] {
  if (cells <= 0) return [];
  if (values.length === 0) return new Array<number>(cells).fill(0);
  if (values.length === cells) return [...values];
  if (values.length < cells) {
    // Upsample by repeating the last known value, so a short series fills right.
    const out = [...values];
    while (out.length < cells) out.push(out[out.length - 1] ?? 0);
    return out;
  }
  const out: number[] = [];
  for (let index = 0; index < cells; index++) {
    const start = Math.floor((index * values.length) / cells);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / cells));
    const slice = values.slice(start, end);
    out.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  }
  return out;
}

/**
 * A fixed-size ring of recent token rates. The footer pushes one sample per
 * status repaint; the sparkline reads the window without the caller managing
 * indices.
 */
export class RateWindow {
  private readonly samples: number[] = [];

  constructor(private readonly capacity = 24) {}

  push(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.samples.push(Math.max(0, rate));
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** The most recent `count` samples, oldest first. */
  last(count: number): number[] {
    return count >= this.samples.length ? [...this.samples] : this.samples.slice(-count);
  }

  get size(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

/**
 * `SRV::5173 ●` — the live dev-server badge. Green when the last lines are
 * clean, red when the sentinel saw an error or the process crashed. Only a
 * process with a detected port earns the badge; a piped script does not.
 */
export function renderServerBadge(processes: readonly ManagedProcess[]): string | undefined {
  const active = processes.find(
    (process) => process.port !== undefined && (process.status === "ready" || process.status === "running"),
  );
  if (active === undefined) return undefined;
  const t = theme();
  const healthy = active.errorCount === 0;
  const dot = t.paint(healthy ? t.colors.feedback.success : t.colors.feedback.error, "●");
  return `${t.paint(t.colors.text.faint, "SRV::")}${t.paint(t.colors.text.base, String(active.port))} ${dot}`;
}
