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
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      const t = theme();
      process.stderr.write(`\r${t.paint(t.colors.accent, FRAMES[this.frame] ?? "")} ${t.paint(t.colors.text.muted, this.label)}`);
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
export function bannerLines(info: BannerInfo): string[] {
  const t = theme();
  const columns = process.stderr.columns ?? 80;
  const width = Math.max(40, Math.min(76, columns - 2));
  // Two shapes, and they differ by one column because the header carries an
  // extra rule character. Getting this wrong by one makes the terminal wrap the
  // line, which adds a row Chrome does not know about and desyncs the layout.
  const bodyInner = width - 3; // "│ " + content + "│"
  const headInner = width - 4; // "╭─ " + content + "╮"

  const title = `${t.bold("carls-code")} ${t.paint(t.colors.text.faint, "·")} ${t.paint(t.colors.text.base, `${info.provider}/${info.model}`)}`;
  const badges = [modeTag(info.mode)];
  if (info.effort !== undefined) badges.push(t.paint(t.colors.accent, info.effort));
  if (info.contextWindow !== undefined) {
    badges.push(t.paint(t.colors.text.muted, `${Math.round(info.contextWindow / 1000)}k ctx`));
  }

  const fitted = truncate(title, headInner);
  const rule = Math.max(0, headInner - visibleWidth(fitted));
  const lines: string[] = [];
  lines.push(`${t.paint(t.colors.border, "╭─ ")}${fitted}${t.paint(t.colors.border, "─".repeat(rule))}${t.paint(t.colors.border, "╮")}`);

  const body = (text: string): string =>
    `${t.paint(t.colors.border, "│ ")}${pad(text, bodyInner)}${t.paint(t.colors.border, "│")}`;
  lines.push(body(badges.join(t.paint(t.colors.text.faint, " · "))));
  lines.push(body(t.paint(t.colors.text.muted, truncate(tildePath(info.cwd), bodyInner))));
  lines.push(body(t.paint(t.colors.text.faint, `session ${info.sessionId}`)));

  const hint = "/ palette · Ctrl+P commands · Shift+Tab mode · ! shell · # note";
  const hintLines = wrap(hint, headInner);
  hintLines.forEach((hintLine, index) => {
    const lead = index === 0 ? "╰─ " : "   ";
    const tail = index === hintLines.length - 1 ? "╯" : "";
    lines.push(
      `${t.paint(t.colors.border, lead)}${t.paint(t.colors.text.faint, pad(hintLine, headInner))}${t.paint(t.colors.border, tail)}`,
    );
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
