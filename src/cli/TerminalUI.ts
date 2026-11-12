import { theme } from "./Theme.js";
import { redact } from "../utils/Logger.js";
import type { Effort, PermissionMode } from "../config/Config.js";
import { pad, truncate, visibleWidth, wrap } from "./Text.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animated spinner writing to stderr so stdout stays clean for piped output. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label = "";
  private enabled: boolean;

  constructor(enabled = process.stderr.isTTY === true) {
    this.enabled = enabled;
  }

  start(label: string): void {
    this.label = label;
    if (!this.enabled || this.timer) return;
    const startedAt = Date.now();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      const t = theme();
      // A long turn with no output looks frozen; the elapsed clock is the
      // cheapest possible reassurance, and it costs one field.
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const clock = elapsed >= 1 ? ` ${t.paint(t.colors.text.faint, `${elapsed}s`)}` : "";
      process.stderr.write(
        `\r\u001b[K${t.paint(t.colors.accent, FRAMES[this.frame] ?? "")} ${t.paint(t.colors.text.muted, this.label)}${clock}`,
      );
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      process.stderr.write("\r\u001b[K");
    }
  }
}

export interface BannerInfo {
  contextWindow?: number;
  model: string;
  provider: string;
  cwd: string;
  sessionId: string;
  mode: PermissionMode;
  effort?: Effort;
}

/** Mode tag with a colour that signals how dangerous it is. */
export function modeTag(mode: PermissionMode): string {
  const t = theme();
  switch (mode) {
    case "plan":
      return t.paint(t.colors.feedback.info, "plan");
    case "pair":
      return t.paint(t.colors.accent, "pair");
    case "ask":
      return t.paint(t.colors.feedback.warning, "ask");
    case "build":
      return t.paint(t.colors.feedback.info, "build");
    case "auto":
      return t.paint(t.colors.feedback.success, "auto");
    case "yolo":
      return t.paint(t.colors.feedback.error, "yolo");
  }
}

/** Collapses the home directory to `~` so the banner stays readable. */
function tildePath(path: string): string {
  const home = process.env.HOME;
  if (home !== undefined && home.length > 1 && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Banner rendered as an array of lines so a fixed header can reuse it.
 *
 * Every line is padded to exactly the box width. Chrome derives its scrolling
 * region from `lines.length`, so a line that is one column too wide wraps in the
 * terminal, adds a row Chrome does not know about, and shifts the whole layout
 * by one on every scroll.
 */
/**
 * The mark is a small framed face: the same character as the boot animation, so
 * the home screen and the splash read as one product without borrowing anyone
 * else's logo. Equal visual width per row keeps the text column straight.
 */
const MARK = ["╭───╮", "│◕ ◕│", "╰─┬─╯"] as const;

/**
 * Home screen, rendered as an array of lines so the fixed header can reuse it.
 *
 * Every line is kept within the terminal width. Chrome derives its scrolling
 * region from `lines.length`, so a line one column too wide wraps in the
 * terminal, adds a row Chrome does not know about, and shifts the whole layout
 * by one on every scroll.
 */
export function bannerLines(info: BannerInfo): string[] {
  const t = theme();
  const columns = process.stderr.columns ?? 80;
  const width = Math.max(40, Math.min(88, columns - 2));
  const gutter = MARK.length > 0 ? visibleWidth(MARK[0] ?? "") + 2 : 0;
  const textWidth = Math.max(16, width - gutter);

  const meta = [modeTag(info.mode)];
  if (info.effort !== undefined) meta.push(t.paint(t.colors.accent, info.effort));
  if (info.contextWindow !== undefined) {
    meta.push(t.paint(t.colors.text.muted, `${Math.round(info.contextWindow / 1000)}k ctx`));
  }

  const rows: string[] = [
    `${t.bold("carls-code")} ${t.paint(t.colors.text.faint, "·")} ${t.paint(t.colors.text.base, `${info.provider}/${info.model}`)}`,
    meta.join(t.paint(t.colors.text.faint, " · ")),
    `${t.paint(t.colors.text.muted, tildePath(info.cwd))} ${t.paint(t.colors.text.faint, `· ${info.sessionId.slice(0, 8)}`)}`,
  ].map((line) => truncate(line, textWidth));

  const hint = "type to ask · @ file · / commands · ctrl+p palette · shift+tab mode · ! shell · # note";
  const hintLines = wrap(hint, textWidth).map((line) => t.paint(t.colors.text.faint, line));

  const lines: string[] = [];
  rows.forEach((row, index) => {
    const mark = MARK[index] ?? "";
    lines.push(`${t.paint(t.colors.border, pad(mark, gutter))}${row}`);
  });
  hintLines.forEach((hintLine, index) => {
    // The tips hang off the mark's chin, so the whole block reads as one shape.
    const lead = index === 0 ? t.paint(t.colors.border, pad("  │", gutter)) : " ".repeat(gutter);
    lines.push(`${lead}${hintLine}`);
  });
  return lines;
}

export function printBanner(info: BannerInfo): void {
  process.stderr.write(`${bannerLines(info).join("\n")}\n\n`);
}

/** Draws a titled box around a list of pre-formatted lines. */
export function printPanel(title: string, lines: string[]): void {
  const t = theme();
  const columns = process.stderr.columns ?? 80;
  const body = lines.map((line) => truncate(line, Math.max(20, columns - 4)));
  const width = Math.min(
    Math.max(20, columns - 2),
    Math.max(visibleWidth(title) + 4, ...body.map(visibleWidth), 24),
  );
  const header = `${t.paint(t.colors.border, "╭─")} ${t.bold(t.paint(t.colors.accent, title))} ${t.paint(t.colors.border, "─".repeat(Math.max(2, width - visibleWidth(title) - 3)))}${t.paint(t.colors.border, "╮")}`;
  process.stderr.write(`${truncate(header, columns)}\n`);
  for (const line of body) {
    process.stderr.write(`${t.paint(t.colors.border, "│")} ${pad(line, width - 2)}${t.paint(t.colors.border, "│")}\n`);
  }
  process.stderr.write(`${t.paint(t.colors.border, `╰${"─".repeat(width)}╯`)}\n`);
}

/**
 * Compact one-line status, reprinted above the prompt after each turn so the
 * user always sees the active mode, model and context pressure without the
 * chrome scrolling away.
 */
export function printStatusBar(info: {
  mode: PermissionMode;
  model: string;
  effort?: Effort;
  /** Fraction of the context window in use, 0..1. */
  usedRatio?: number;
  contextWindow?: number;
}): void {
  const t = theme();
  const parts = [modeTag(info.mode), t.paint(t.colors.text.muted, info.model)];
  if (info.effort !== undefined) parts.push(t.paint(t.colors.accent, info.effort));
  if (info.usedRatio !== undefined) {
    const pct = Math.min(100, info.usedRatio * 100);
    const paint = pct > 85 ? t.colors.feedback.error : pct > 70 ? t.colors.feedback.warning : t.colors.text.faint;
    parts.push(t.paint(paint, `${pct.toFixed(0)}% ctx`));
  }
  process.stderr.write(`${t.paint(t.colors.border, "─")} ${parts.join(t.paint(t.colors.text.faint, " · "))}\n`);
}

export function printToolResult(name: string, ok: boolean, summary: string): void {
  const t = theme();
  const icon = ok ? t.paint(t.colors.feedback.success, "✓") : t.paint(t.colors.feedback.error, "✗");
  process.stderr.write(`${icon} ${t.bold(name)} ${t.paint(t.colors.text.muted, summary)}\n`);
}

export function printCost(text: string): void {
  process.stderr.write(`${theme().paint(theme().colors.text.faint, "·")} ${theme().paint(theme().colors.text.faint, text)}\n`);
}

/** Marks the start of the assistant's answer, so the transcript reads as a chat. */
export function printAssistantHeader(): void {
  const t = theme();
  process.stdout.write(`\n${t.paint(t.colors.accent, "◆")} ${t.bold("carls")}\n`);
}

export function printError(text: string): void {
  const t = theme();
  process.stderr.write(`${t.paint(t.colors.feedback.error, "✗")} ${redact(text)}\n`);
}

export function printInfo(text: string): void {
  const t = theme();
  process.stderr.write(`${t.paint(t.colors.feedback.info, "·")} ${redact(text)}\n`);
}
