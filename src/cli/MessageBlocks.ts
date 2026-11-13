import pc from "picocolors";
import { homedir } from "node:os";
import { theme } from "./Theme.js";

/**
 * Pure block renderers for the full-screen conversation stream.
 *
 * The REPL used to print ad-hoc one-liners. These functions give the viewport
 * the OpenCode-style shape: a user card, a reasoning header, compact tool cards
 * with live/finished/failed states, and a one-row header bar. They return plain
 * strings (ANSI included) so the viewport can wrap them without knowing where
 * they will land.
 */

export interface HeaderInfo {
  version: string;
  mode: string;
  model: string;
  provider?: string;
  cwd: string;
  sessionId: string;
}

function shortPath(cwd: string): string {
  const home = homedir();
  if (home.length > 1 && cwd.startsWith(home)) {
    const rest = cwd.slice(home.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
    return rest.length > 0 ? `~/${rest}` : "~";
  }
  return cwd;
}

/** One-row top header: `╭─ carls vX ─ [AGENT: MODE] ─ model ─ cwd ─ [Session #id] ─╮`. */
export function headerBar(info: HeaderInfo): string {
  const t = theme();
  const model = info.provider !== undefined ? `${info.provider}/${info.model}` : info.model;
  const session = info.sessionId.length > 12 ? info.sessionId.slice(-12) : info.sessionId;
  const parts = [
    `carls v${info.version}`,
    `[AGENT: ${info.mode.toUpperCase()}]`,
    model,
    shortPath(info.cwd),
    `[Session #${session}]`,
  ];
  const body = parts.join(pc.gray(" ─ "));
  return `${t.paint(t.colors.border, "╭─ ")}${body}${t.paint(t.colors.border, " ─╮")}`;
}

/** A user turn with a thick accent rail, local time and mode badge. */
export function userBlock(text: string, mode: string, at: Date = new Date()): string[] {
  const t = theme();
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const rail = t.paint(t.colors.accent, "┃");
  const badge = t.paint(t.colors.text.faint, `${time} · ${mode.toUpperCase()}`);
  const body = text.replace(/\r\n/g, "\n").split("\n");
  return [
    `${rail} ${badge}`,
    ...body.map((line) => `${rail} ${line}`),
    "",
  ];
}

/** Header of a reasoning block, shown while the model streams its scratchpad. */
export function reasoningHeader(label = "Razonando", elapsed?: string): string {
  const t = theme();
  const clock = elapsed !== undefined ? ` ${t.paint(t.colors.text.faint, `(${elapsed})`)}` : "";
  return `${t.paint(t.colors.border, "╭─ ")}${t.paint(t.colors.text.muted, `⠋ ${label}`)}${clock}${t.paint(t.colors.border, " ─╮")}`;
}

/** Closing line of a reasoning block after the answer starts. */
export function reasoningFooter(elapsed?: string): string {
  const t = theme();
  const summary = elapsed !== undefined ? `razonamiento oculto · ${elapsed}` : "razonamiento oculto";
  return `${t.paint(t.colors.border, "╰─ ")}${t.paint(t.colors.text.faint, summary)}${t.paint(t.colors.border, " ─╯")}`;
}

export type ToolCardState = "running" | "ok" | "failed";

export interface ToolCardInfo {
  name: string;
  detail?: string;
  state: ToolCardState;
  durationMs?: number;
  /** Compact preview lines, already plain text. */
  preview?: readonly string[];
}

/** A tool call as a compact, bordered card. */
export function toolCard(info: ToolCardInfo): string[] {
  const t = theme();
  const glyph = info.state === "running" ? "⠋" : info.state === "ok" ? "✓" : "✗";
  const stateColor =
    info.state === "running"
      ? t.paint(t.colors.accent, glyph)
      : info.state === "ok"
        ? t.paint(t.colors.feedback.success, glyph)
        : t.paint(t.colors.feedback.error, glyph);
  const time = info.durationMs !== undefined ? ` [${(info.durationMs / 1000).toFixed(1)}s]` : "";
  const detail = info.detail !== undefined && info.detail.length > 0 ? `  ${info.detail}` : "";
  const border = t.paint(t.colors.border, "╭─");
  const tail = t.paint(t.colors.border, ` ${"─".repeat(6)}${time ? ` ${time.trim()}` : ""} ─╮`);
  const head = `${border} ${stateColor} ${t.bold(info.name)}${detail}${tail}`;
  const lines = [head];
  for (const preview of (info.preview ?? []).slice(0, 8)) {
    lines.push(`${t.paint(t.colors.border, "│")} ${preview}`);
  }
  lines.push(t.paint(t.colors.border, "╰────────────────────────────────"));
  return lines;
}

/** A completed tool card, keeping the failed state visually distinct. */
export function toolResultCard(
  name: string,
  detail: string | undefined,
  ok: boolean,
  durationMs: number,
  preview: readonly string[] = [],
): string[] {
  return toolCard({ name, ...(detail !== undefined ? { detail } : {}), state: ok ? "ok" : "failed", durationMs, preview });
}

/** Small status used by the home-directory hint in the footer. */
export function homeIndexHint(): string {
  return pc.gray("[HOME DIR: indexación @ bajo demanda]");
}
