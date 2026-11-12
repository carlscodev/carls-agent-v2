import pc from "picocolors";
import { visibleWidth } from "./Text.js";

const ESC = "\u001b[";
const SAVE = "\u001b7";
const RESTORE = "\u001b8";

export interface ChromeLayout {
  /** Rows occupied by the fixed header, 1-based. */
  headerRows: number;
  /** First row of the scrolling conversation region. */
  regionTop: number;
  /** Last row of the scrolling conversation region. */
  regionBottom: number;
  /** Row holding the status line. */
  statusRow: number;
  /** Row holding the input prompt. */
  promptRow: number;
  /** Total terminal rows. */
  height: number;
}

/**
 * Keeps a fixed header and a footer (status line plus prompt) on screen while
 * the conversation scrolls between them, the way a full-screen TUI does.
 *
 * The trick is the terminal's scrolling region (DECSTBM): rows outside the
 * region never scroll, so the header and footer stay put while output streams
 * into the middle. Everything is disabled when stdout is not a TTY, so piped
 * output is unaffected.
 */
export class Chrome {
  private enabled = false;
  private headerLines: string[] = [];
  private statusText = "";
  private readonly out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream = process.stderr) {
    this.out = out;
  }

  static supported(out: NodeJS.WriteStream = process.stderr): boolean {
    return out.isTTY === true;
  }

  get active(): boolean {
    return this.enabled;
  }

  /** Draws the header and reserves the scrolling region. */
  enable(headerLines: string[]): ChromeLayout | undefined {
    if (!Chrome.supported(this.out)) return undefined;
    this.enabled = true;
    this.headerLines = headerLines;
    this.out.write("\u001b[?25l");
    this.layout = this.computeLayout();
    this.drawHeader();
    this.applyRegion();
    this.moveToRegionBottom();
    this.out.write("\u001b[?25h");
    return this.layout;
  }

  private layout: ChromeLayout = {
    headerRows: 0,
    regionTop: 1,
    regionBottom: 1,
    statusRow: 1,
    promptRow: 1,
    height: 24,
  };

  current(): ChromeLayout {
    return this.layout;
  }

  private computeLayout(): ChromeLayout {
    const height = Math.max(12, this.out.rows ?? 24);
    const headerRows = Math.min(this.headerLines.length, Math.max(0, height - 6));
    const statusRow = height - 1;
    const promptRow = height;
    const regionTop = headerRows + 1;
    const regionBottom = Math.max(regionTop, statusRow - 1);
    return { headerRows, regionTop, regionBottom, statusRow, promptRow, height };
  }

  /** Recomputes after a terminal resize. */
  resize(): void {
    if (!this.enabled) return;
    this.layout = this.computeLayout();
    this.drawHeader();
    this.applyRegion();
    this.moveToRegionBottom();
  }

  private drawHeader(): void {
    const { height } = this.layout;
    for (let index = 0; index < Math.min(this.headerLines.length, height - 2); index++) {
      const line = this.headerLines[index] ?? "";
      this.out.write(`${ESC}${index + 1};1H${ESC}2K${line}`);
    }
  }

  private applyRegion(): void {
    const { regionTop, regionBottom } = this.layout;
    this.out.write(`${ESC}${regionTop};${regionBottom}r`);
  }

  /** Puts the cursor at the bottom of the conversation region. */
  moveToRegionBottom(): void {
    if (!this.enabled) return;
    this.out.write(`${ESC}${this.layout.regionBottom};1H`);
  }

  /**
   * Writes a block of text into the conversation region. The caller is expected
   * to have positioned the cursor with `moveToRegionBottom` first; consecutive
   * calls stream naturally and scroll the region.
   */
  writeRegion(text: string): void {
    if (!this.enabled) {
      this.out.write(text);
      return;
    }
    this.out.write(text);
  }

  /** Redraws the status line without disturbing the conversation cursor. */
  setStatus(text: string): void {
    this.statusText = text;
    this.drawStatus();
  }

  drawStatus(): void {
    if (!this.enabled) return;
    const { statusRow, height } = this.layout;
    const width = this.out.columns ?? 80;
    const body = fit(this.statusText, width);
    this.out.write(`${SAVE}${ESC}${statusRow};1H${ESC}2K${body}${RESTORE}`);
    void height;
  }

  /** Draws the input line at the reserved prompt row. */
  drawPrompt(promptText: string, buffer: string, cursor: number): void {
    if (!this.enabled) return;
    const { promptRow } = this.layout;
    const width = this.out.columns ?? 80;
    // An empty prompt shows what it accepts instead of a bare glyph; the cursor
    // still sits right after the prompt, so the placeholder never gets in the way.
    const ghost = buffer.length === 0 ? pc.gray("ask for a change, or / for commands") : "";
    const line = fit(`${promptText}${buffer}${ghost}`, width);
    this.out.write(`${ESC}${promptRow};1H${ESC}2K${line}`);
    const used = visibleWidth(promptText) + cursor;
    const column = Math.min(width - 1, used) + 1;
    this.out.write(`${ESC}${promptRow};${column}H`);
  }

  /** Clears the input row after a line is submitted. */
  clearPrompt(): void {
    if (!this.enabled) return;
    const { promptRow } = this.layout;
    this.out.write(`${ESC}${promptRow};1H${ESC}2K`);
  }

  /** Temporarily restores normal scrolling, e.g. for a full-screen selector. */
  suspend(): void {
    if (!this.enabled) return;
    this.out.write(`${ESC}r`);
    this.clearPrompt();
    this.out.write(`${ESC}${this.layout.height};1H`);
  }

  resume(): void {
    if (!this.enabled) return;
    this.applyRegion();
    this.moveToRegionBottom();
    this.drawStatus();
  }

  /** Restores the terminal and prints the closing line. */
  disable(finalLine?: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.out.write(`${ESC}r`);
    const { statusRow, promptRow } = this.layout;
    this.out.write(`${ESC}${statusRow};1H${ESC}2K`);
    this.out.write(`${ESC}${promptRow};1H${ESC}2K`);
    if (finalLine !== undefined) this.out.write(`${ESC}${promptRow};1H${finalLine}\n`);
    else this.out.write(`${ESC}${promptRow};1H\n`);
  }
}

/** Truncates to the terminal width, keeping colour escapes intact. */
function fit(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let visible = 0;
  let index = 0;
  while (index < text.length && visible < width - 1) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    visible += 1;
    index += 1;
  }
  return `${text.slice(0, index)}${pc.gray("…")}`;
}
