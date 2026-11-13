import { mixRgb, theme } from "./Theme.js";
import { truncate } from "./Text.js";

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

/**
 * One sub-agent as the fleet line needs it: its role, its goal, and the last
 * thing it was seen doing.
 */
export interface AgentFleetEntry {
  role: string;
  goal: string;
  /** Most recent progress message, e.g. `read_file src/core/Runtime.ts`. */
  detail?: string;
}

/**
 * Renders the live sub-agent fleet as a single row.
 *
 * Each child gets a spinner glyph and its goal; the goal shown is the one the
 * operator can act on, so it is preferred over the raw tool call. The row is the
 * only place the fleet is visible while it runs, so it must breathe: the glyph
 * advances with `tick` exactly like the phase timeline.
 */
export function renderAgentFleet(agents: readonly AgentFleetEntry[], tick: number, width?: number): string {
  const t = theme();
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⠋";
  const parts = agents.map((agent) => {
    const glyph = t.paint(t.colors.accent, spinner);
    const role = t.paint(t.colors.text.base, agent.role);
    const detail = agent.detail !== undefined && agent.detail.length > 0 ? agent.detail : agent.goal;
    return `${glyph} ${role} ${t.paint(t.colors.text.faint, truncate(detail, 42))}`;
  });
  const count = agents.length === 1 ? "1 subagente" : `${agents.length} subagentes`;
  const head = t.paint(t.colors.text.faint, `⚙ ${count}`);
  const line = [head, ...parts].join(t.paint(t.colors.border, " · "));
  return width !== undefined ? truncate(line, width) : line;
}

export function formatElapsed(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}s`;
  const totalSeconds = Math.floor(totalTenths / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Dim slate the shimmer starts from. */
const SHIMMER_DIM = { r: 0x6e, g: 0x7a, b: 0x75 } as const;
/** Mint crest of the shimmer wave. */
const SHIMMER_MINT = { r: 0xa7, g: 0xf3, b: 0xd0 } as const;

/**
 * Paints a brightness wave that travels across `text`, between slate grey, mint
 * and the neon accent. Pure in `tick`: the same tick always yields the same
 * string, so the frame is reproducible in a test and cheap to diff.
 *
 * Spaces are left unpainted so a label keeps its shape instead of turning into a
 * solid coloured bar. The accent is read from the active theme, so a light
 * terminal gets its own accent rather than a neon green that would vanish.
 */
export function renderShimmerText(text: string, tick: number, period = 6): string {
  const t = theme();
  const accent = t.colors.accent;
  const span = Math.max(2, period);
  const width = text.length;
  let out = "";
  for (let index = 0; index < width; index++) {
    const char = text[index] ?? "";
    if (char === " ") {
      out += char;
      continue;
    }
    // The crest sweeps left to right and wraps, so the wave reads as motion
    // even on a short label.
    const phase = (((index - tick) % span) + span) % span;
    const ratio = phase / span;
    const colour =
      ratio < 0.5
        ? mixRgb(SHIMMER_DIM, SHIMMER_MINT, ratio * 2)
        : mixRgb(SHIMMER_MINT, accent, (ratio - 0.5) * 2);
    out += t.paint(colour, char);
  }
  return out;
}

export type PhaseStatus = "pending" | "running" | "done" | "failed";

export interface PhaseCell {
  status: PhaseStatus;
  /** Label shown inside the cell, e.g. `ACT: edit_file`. */
  label: string;
  /** Live clock, e.g. `0.4s`. Only shown while running. */
  elapsed?: string;
}

export interface PhaseTimelineState {
  think: PhaseCell;
  act: PhaseCell;
  verify: PhaseCell;
  /** Frame number driving the spinner and the gradient bar. */
  tick: number;
}

const PHASE_GRADIENT = ["░", "░", "▒", "▒", "▓", "▓", "█", "█", "▓", "▓", "▒", "▒"] as const;

function phaseGlyph(status: PhaseStatus, tick: number): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "running") return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⠋";
  return "○";
}

function phaseColour(status: PhaseStatus): { r: number; g: number; b: number } {
  const t = theme();
  if (status === "done") return t.colors.feedback.success;
  if (status === "failed") return t.colors.feedback.error;
  if (status === "running") return t.colors.accent;
  return t.colors.text.faint;
}

function phaseCell(cell: PhaseCell, tick: number): string {
  const t = theme();
  const colour = phaseColour(cell.status);
  const glyph = t.paint(colour, phaseGlyph(cell.status, tick));
  const label = cell.status === "running" ? renderShimmerText(cell.label, tick) : t.paint(colour, cell.label);
  const clock = cell.status === "running" && cell.elapsed !== undefined ? t.paint(t.colors.text.faint, ` ${cell.elapsed}`) : "";
  return t.paint(t.colors.border, "[ ") + `${glyph} ${label}${clock}` + t.paint(t.colors.border, " ]");
}

/** A short gradient bar that reads as flow between two phases. */
function phaseConnector(active: boolean, tick: number): string {
  const t = theme();
  if (!active) return t.paint(t.colors.border, "──▶");
  const bar = Array.from({ length: 6 }, (_unused, index) => {
    const glyph = PHASE_GRADIENT[(index + tick) % PHASE_GRADIENT.length] ?? "░";
    return t.paint(t.colors.accent, glyph);
  }).join("");
  return `${bar}${t.paint(t.colors.border, "▶")}`;
}

/**
 * Renders the Gather -> Act -> Verify progress line drawn above the composer.
 *
 * Each phase is a bracketed cell with its own state glyph; the connector between
 * two phases animates only while the later one is running, so the eye lands on
 * whatever the agent is doing now. The whole line is truncated to `width`, so a
 * narrow terminal loses the tail rather than wrapping the footer.
 */
export function renderPhaseTimeline(state: PhaseTimelineState, width?: number): string {
  const think = phaseCell(state.think, state.tick);
  const act = phaseCell(state.act, state.tick);
  const verify = phaseCell(state.verify, state.tick);
  const line = [
    think,
    phaseConnector(state.act.status === "running", state.tick),
    act,
    phaseConnector(state.verify.status === "running", state.tick),
    verify,
  ].join(" ");
  return width !== undefined ? truncate(line, width) : line;
}
