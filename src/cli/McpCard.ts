import { pad, terminalDimension, truncate, visibleWidth } from "./Text.js";
import { theme } from "./Theme.js";

/**
 * First-class MCP dashboard.
 *
 * MCP is a different kind of tool: a remote server with a transport, a latency
 * and a set of exposed tools. Rendering it as a flat "name: N tools" line hides
 * exactly the information an operator needs when a server misbehaves. This card
 * gives every server a status light, a transport, a latency and its tool names.
 */

export type McpStatus = "online" | "idle" | "error";

export interface McpServerView {
  name: string;
  status: McpStatus;
  transport: string;
  version?: string | undefined;
  latencyMs?: number | undefined;
  tools: readonly string[];
  error?: string | undefined;
}

export interface McpDashboardOptions {
  width?: number | undefined;
}

function statusBadge(status: McpStatus): string {
  const t = theme();
  if (status === "online") return t.paint(t.colors.feedback.success, "● ONLINE");
  if (status === "error") return t.paint(t.colors.feedback.error, "✗ ERROR");
  return t.paint(t.colors.text.faint, "○ IDLE");
}

function contentLine(text: string, width: number): string {
  const inner = Math.max(1, width - 4);
  return `${theme().paint(theme().colors.border, "│")} ${pad(truncate(text, inner), inner)} ${theme().paint(theme().colors.border, "│")}`;
}

export function renderMcpDashboard(
  servers: readonly McpServerView[],
  options: McpDashboardOptions = {},
): string[] {
  const t = theme();
  const width = Math.max(48, Math.min(options.width ?? terminalDimension(undefined, 100), 140));
  const inner = width - 2;
  const title = " MCP ";
  const count = ` ${servers.length} server${servers.length === 1 ? "" : "s"} `;
  const dashes = Math.max(1, inner - 2 - visibleWidth(title) - visibleWidth(count));
  const top = `${t.paint(t.colors.border, "╭─")}${t.paint(t.colors.accent, title)}${t.paint(
    t.colors.border,
    "─".repeat(dashes),
  )}${t.paint(t.colors.text.faint, count)}${t.paint(t.colors.border, "─╮")}`;
  const bottom = t.paint(t.colors.border, `╰${"─".repeat(inner)}╯`);
  const lines: string[] = [top];

  if (servers.length === 0) {
    lines.push(contentLine(t.paint(t.colors.text.faint, "No MCP servers configured."), width));
  }

  for (const server of servers) {
    const version = server.version !== undefined ? t.paint(t.colors.text.faint, ` v${server.version}`) : "";
    const latency =
      server.latencyMs !== undefined ? t.paint(t.colors.text.muted, `${server.latencyMs}ms`) : t.paint(t.colors.text.faint, "—");
    const transport = t.paint(t.colors.feedback.info, server.transport);
    const tools = t.paint(t.colors.text.faint, `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`);
    lines.push(contentLine(`${statusBadge(server.status)}  ${t.bold(server.name)}${version}  ${transport}  ${latency}  ${tools}`, width));
    if (server.error !== undefined && server.error.length > 0) {
      lines.push(contentLine(`  ${t.paint(t.colors.feedback.error, truncate(server.error, inner - 6))}`, width));
    }
    server.tools.forEach((tool, index) => {
      const connector = index === server.tools.length - 1 ? "╰─" : "├─";
      lines.push(contentLine(`  ${t.paint(t.colors.border, connector)} ${t.paint(t.colors.text.muted, tool)}`, width));
    });
    if (server.tools.length === 0) {
      lines.push(contentLine(`  ${t.paint(t.colors.text.faint, "╰─ (no tools exposed)")}`, width));
    }
  }

  lines.push(bottom);
  return lines;
}
