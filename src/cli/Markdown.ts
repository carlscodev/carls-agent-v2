import { theme } from "./Theme.js";

/**
 * Renders assistant markdown for a terminal, line by line, so it can be used
 * while tokens stream in. It handles the subset models actually emit: headings,
 * lists, fenced code blocks, inline code, bold and links.
 */
export class MarkdownRenderer {
  private buffer = "";
  private inFence = false;
  private fenceLang = "";
  private readonly out: NodeJS.WriteStream;
  /** Visible width of a code-block rule. */
  private readonly barWidth: number;

  constructor(out: NodeJS.WriteStream = process.stdout, width?: number) {
    this.out = out;
    this.barWidth = Math.max(8, Math.min(60, width ?? (out.columns ?? 100) - 2));
  }

  /** Feeds a stream chunk; complete lines are rendered immediately. */
  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.renderLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Renders whatever is left without a trailing newline. */
  flush(): void {
    if (this.buffer.length > 0) {
      this.renderLine(this.buffer);
      this.buffer = "";
    }
    if (this.inFence) {
      this.closeFence();
    }
  }

  /** Width of a code-block rule, never below the two corners. */
  private ruleWidth(extra = 0): number {
    return Math.max(2, this.barWidth - extra);
  }

  private closeFence(): void {
    const t = theme();
    this.out.write(`${t.paint(t.colors.border, "╰" + "─".repeat(this.ruleWidth()))}\n`);
    this.inFence = false;
  }

  private renderLine(line: string): void {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (this.inFence) {
        this.closeFence();
      } else {
        const t = theme();
        this.fenceLang = fence[1] ?? "";
        const label =
          this.fenceLang.length > 0
            ? `${t.paint(t.colors.border, "─")}${t.paint(t.colors.text.muted, ` ${this.fenceLang} `)}`
            : "";
        const bar = t.paint(t.colors.border, "─".repeat(this.ruleWidth(this.fenceLang.length + 4)));
        this.out.write(`${t.paint(t.colors.border, "╭")}${label}${bar}\n`);
        this.inFence = true;
      }
      return;
    }

    if (this.inFence) {
      this.out.write(`${theme().paint(theme().colors.border, "│")} ${theme().paint(theme().colors.markdown.code, line)}\n`);
      return;
    }

    if (line.trim().length === 0) {
      this.out.write("\n");
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const t = theme();
      const text = heading[2] ?? "";
      this.out.write(`${t.bold(t.paint(t.colors.markdown.heading, text))}\n`);
      return;
    }

    const bullet = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const indent = " ".repeat(Math.min((bullet[1] ?? "").length, 8));
      const marker = bullet[2] ?? "-";
      const glyph = marker.endsWith(".") ? marker : "•";
      const t = theme();
      const colour = marker.endsWith(".") ? t.colors.markdown.enumeration : t.colors.markdown.bullet;
      this.out.write(`${indent}${t.paint(colour, glyph)} ${this.inline(bullet[3] ?? "")}\n`);
      return;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const t = theme();
      this.out.write(`${t.paint(t.colors.border, "│")} ${t.italic(t.paint(t.colors.markdown.quote, this.inline(quote[1] ?? "")))}\n`);
      return;
    }

    this.out.write(`${this.inline(line)}\n`);
  }

  /** Applies inline emphasis to a single line. */
  private inline(text: string): string {
    const t = theme();
    let out = text;
    // Inline code first so its contents are not treated as emphasis.
    const codes: string[] = [];
    out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
      codes.push(t.paint(t.colors.markdown.code, code));
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => t.bold(t.paint(t.colors.markdown.strong, bold)));
    out = out.replace(/(^|\s)\*([^*\n]+)\*/g, (_m, lead: string, ital: string) => `${lead}${t.italic(t.paint(t.colors.markdown.emphasis, ital))}`);
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label: string, url: string) => `${t.paint(t.colors.markdown.linkText, label)} ${t.paint(t.colors.text.faint, `(${url})`)}`,
    );
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
    return out;
  }
}
