import { pad, terminalDimension, truncate, visibleWidth } from "./Text.js";
import { theme } from "./Theme.js";

/**
 * Clean-exit banner.
 *
 * A session that ends without telling the operator how to come back is a dead
 * end. The banner is deliberately plain text for the command itself (copy and
 * paste must work) and styled only around it. `TERMINAL_RESTORE` undoes every
 * mode this TUI can leave behind: synchronized output, bracketed paste, a hidden
 * cursor and a scrolling region.
 */

export const TERMINAL_RESTORE = "\u001b[?2026h\u001b[?2026l\u001b[?2004l\u001b[?25h\u001b[r";

export function restoreTerminal(output: NodeJS.WriteStream = process.stderr): void {
  output.write(TERMINAL_RESTORE);
}

function contentLine(text: string, width: number): string {
  const inner = Math.max(1, width - 4);
  return `│ ${pad(truncate(text, inner), inner)} │`;
}

export function formatSessionBanner(sessionId: string, turns: number, width = 72): string[] {
  const t = theme();
  const safeWidth = Math.max(48, Math.floor(width));
  const title = " Sesión guardada ";
  const inner = safeWidth - 2;
  const top = `${t.paint(t.colors.border, "╭─")}${t.paint(t.colors.accent, title)}${t.paint(
    t.colors.border,
    "─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮",
  )}`;
  const bottom = t.paint(t.colors.border, `╰${"─".repeat(inner)}╯`);
  const lines = [
    top,
    contentLine(`ID de sesión : ${sessionId}`, safeWidth),
    contentLine(`Mensajes     : ${turns} turnos guardados (Estado DAG y reglas intactos)`, safeWidth),
    contentLine("", safeWidth),
    contentLine("Para reanudar exactamente donde lo dejaste, ejecuta:", safeWidth),
    contentLine(`  carls --resume ${sessionId}`, safeWidth),
    bottom,
  ];
  return lines;
}

export function writeSessionBanner(
  output: NodeJS.WriteStream,
  sessionId: string,
  turns: number,
): void {
  restoreTerminal(output);
  const width = Math.max(48, Math.min(terminalDimension(output.columns, 72), 100));
  output.write(`${formatSessionBanner(sessionId, turns, width).join("\n")}\n`);
}
