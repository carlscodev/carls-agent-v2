import pc from "picocolors";
import { terminalDimension, visibleWidth } from "./Text.js";

const ESC = "\u001b[";
const SAVE = "\u001b7";
const RESTORE = "\u001b8";

export interface ChromeLayout {
  /** Rows occupied by the fixed header, 1-based. */
  headerRows: number;
  /** Row holding the tab strip, or 0 when no tabs are shown. */
  tabRow: number;
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
  /** One line of tab labels, or undefined when the strip is hidden. */
  private tabStrip: string | undefined;
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
    tabRow: 0,
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
    const rows = this.out.rows ?? 0;
    const height = Math.max(12, rows > 0 ? rows : 24);
    const tabRows = this.tabStrip === undefined ? 0 : 1;
    // The strip takes its row out of the header's budget, so the footer rows and
    // at least one conversation row survive on a short terminal.
    const headerRows = Math.min(this.headerLines.length, Math.max(0, height - 6 - tabRows));
    const statusRow = height - 1;
    const promptRow = height;
    const tabRow = tabRows === 1 ? headerRows + 1 : 0;
    const regionTop = headerRows + tabRows + 1;
    const regionBottom = Math.max(regionTop, statusRow - 1);
    return { headerRows, tabRow, regionTop, regionBottom, statusRow, promptRow, height };
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
    // Only `layout.headerRows` lines may be painted: on a short terminal that
    // budget is smaller than the banner, and drawing the overflow would land on
    // the tab strip's row and erase it.
    for (let index = 0; index < this.layout.headerRows; index++) {
      const line = this.headerLines[index] ?? "";
      this.out.write(`${ESC}${index + 1};1H${ESC}2K${line}`);
    }
    this.drawTabs();
  }

  /**
   * Sets the tab strip. Passing undefined hides it and gives the row back to
   * the header, so a single-tab session looks exactly as it did before.
   */
  setTabs(strip: string | undefined): void {
    const had = this.tabStrip !== undefined;
    const has = strip !== undefined;
    this.tabStrip = strip;
    if (!this.enabled) return;
    if (had !== has) {
      this.layout = this.computeLayout();
      this.applyRegion();
      this.moveToRegionBottom();
    }
    this.drawHeader();
  }

  private drawTabs(): void {
    if (this.tabStrip === undefined || this.layout.tabRow === 0) return;
    const width = terminalDimension(this.out.columns);
    const line = fit(this.tabStrip, width);
    this.out.write(`${ESC}${this.layout.tabRow};1H${ESC}2K${line}`);
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
    const width = terminalDimension(this.out.columns);
    const body = fit(this.statusText, width);
    this.out.write(`${SAVE}${ESC}${statusRow};1H${ESC}2K${body}${RESTORE}`);
    void height;
  }

  /** Draws the input line at the reserved prompt row. */
  drawPrompt(promptText: string, buffer: string, cursor: number): void {
    if (!this.enabled) return;
    const { promptRow } = this.layout;
    const width = terminalDimension(this.out.columns);
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
