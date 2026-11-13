import pc from "picocolors";
import { terminalDimension, visibleWidth } from "./Text.js";
import { FrameRenderer } from "./FrameRenderer.js";

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
  /** First row of the completion menu, or 0 when the menu is hidden. */
  menuTop: number;
  /** Rows the completion menu occupies. */
  menuRows: number;
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
  /** Completion menu rows, drawn just above the status line. */
  private menuLines: string[] = [];
  private readonly out: NodeJS.WriteStream;
  /** Diffing writers for the three rows that change while the TUI runs. */
  private readonly statusFrame: FrameRenderer;
  private readonly menuFrame: FrameRenderer;
  private readonly promptFrame: FrameRenderer;

  constructor(out: NodeJS.WriteStream = process.stderr) {
    this.out = out;
    // Chrome updates are small and latency-sensitive: write them immediately,
    // but let the renderer drop unchanged rows and wrap each batch in Mode 2026.
    this.statusFrame = new FrameRenderer(out, { coalesce: false });
    this.menuFrame = new FrameRenderer(out, { coalesce: false });
    this.promptFrame = new FrameRenderer(out, { coalesce: false });
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
    menuTop: 0,
    menuRows: 0,
    height: 24,
  };

  current(): ChromeLayout {
    return this.layout;
  }

  /**
   * Top row for a bottom dock panel of `height` rows. The wizard uses it to sit
   * just above the footer without touching the fixed header.
   */
  wizardOrigin(height: number): number {
    return Math.max(1, this.layout.height - Math.max(1, height) - 1);
  }

  private computeLayout(): ChromeLayout {
    const rows = this.out.rows ?? 0;
    const height = Math.max(12, rows > 0 ? rows : 24);
    const tabRows = this.tabStrip === undefined ? 0 : 1;
    const menuRows = this.menuLines.length;
    // The strip and the menu take their rows out of the header's budget, so the
    // footer rows and at least one conversation row survive on a short terminal.
    const headerRows = Math.min(this.headerLines.length, Math.max(0, height - 6 - tabRows - menuRows));
    const statusRow = height - 1;
    const promptRow = height;
    const tabRow = tabRows === 1 ? headerRows + 1 : 0;
    const regionTop = headerRows + tabRows + 1;
    const menuTop = statusRow - menuRows;
    const regionBottom = Math.max(regionTop, menuTop - 1);
    return { headerRows, tabRow, regionTop, regionBottom, statusRow, promptRow, height, menuTop, menuRows };
  }

  /** Recomputes after a terminal resize. */
  resize(): void {
    if (!this.enabled) return;
    this.layout = this.computeLayout();
    // Every origin moved, so the previous frame buffers describe the wrong rows.
    this.statusFrame.reset();
    this.menuFrame.reset();
    this.promptFrame.reset();
    this.drawHeader();
    this.applyRegion();
    this.moveToRegionBottom();
    this.drawMenu();
    this.drawStatus();
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

  /**
   * Sets the completion menu. Passing an empty array hides it and gives the rows
   * back to the conversation region, so the layout is identical to a run without
   * a menu. Rows are counted from the bottom so the menu always sits flush above
   * the status line.
   */
  setMenu(lines: string[]): void {
    const hadRows = this.menuLines.length;
    const hadTop = this.layout.menuTop;
    this.menuLines = lines;
    if (!this.enabled) return;
    if (hadRows !== lines.length) {
      // Erase the old rows using the layout that still knows where they are,
      // otherwise shrinking the menu leaves its text stranded on screen.
      for (let index = 0; index < hadRows; index++) {
        this.out.write(`${ESC}${hadTop + index};1H${ESC}2K`);
      }
      this.layout = this.computeLayout();
      this.applyRegion();
      this.moveToRegionBottom();
    }
    this.menuFrame.reset();
    this.drawMenu();
  }

  private drawMenu(): void {
    const { menuRows, menuTop } = this.layout;
    if (menuRows === 0 || menuTop === 0) return;
    const width = terminalDimension(this.out.columns);
    const lines = this.menuLines.map((line) => fit(line, width));
    this.menuFrame.render(lines, { originRow: menuTop });
  }

  /** Clears every menu row and collapses the reserved space. */
  clearMenu(): void {
    this.setMenu([]);
  }

  /** Redraws the status line without disturbing the conversation cursor. */
  setStatus(text: string): void {
    this.statusText = text;
    this.drawStatus();
  }

  drawStatus(): void {
    if (!this.enabled) return;
    const { statusRow } = this.layout;
    const width = terminalDimension(this.out.columns);
    const body = fit(this.statusText, width);
    // The cursor must come back to the conversation region: the status frame is
    // positioned absolutely, and leaving it there would send the next write to
    // the footer row.
    this.out.write(SAVE);
    this.statusFrame.render([body], { originRow: statusRow });
    this.out.write(RESTORE);
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
    this.promptFrame.render([line], { originRow: promptRow });
    const used = visibleWidth(promptText) + cursor;
    const column = Math.min(width - 1, used) + 1;
    this.out.write(`${ESC}${promptRow};${column}H`);
  }

  /** Clears the input row after a line is submitted. */
  clearPrompt(): void {
    if (!this.enabled) return;
    const { promptRow } = this.layout;
    this.promptFrame.clear();
    this.out.write(`${ESC}${promptRow};1H${ESC}2K`);
  }

  /** Clears the reserved status row. */
  private clearStatus(): void {
    if (!this.enabled) return;
    this.statusFrame.clear();
    this.out.write(`${ESC}${this.layout.statusRow};1H${ESC}2K`);
  }

  /**
   * Temporarily restores normal scrolling, e.g. for a full-screen selector.
   *
   * Two things matter here. The region must be reset, because a selector draws
   * into the alternate screen and a live region would clip its frame. And the
   * cursor must be left inside the conversation region, not on the last row: with
   * the region off, a newline written at the bottom of the screen scrolls the
   * whole screen, which would drag the status line up into the transcript. That
   * is what made every `/resume` leave another footer behind.
   */
  suspend(): void {
    if (!this.enabled) return;
    // The menu belongs to the prompt line, and the caller is about to hand the
    // screen to a full-screen selector. Clear its rows first (using the current
    // layout, which still knows where they are) and give the space back.
    const { menuTop, menuRows } = this.layout;
    for (let index = 0; index < menuRows; index++) {
      this.out.write(`${ESC}${menuTop + index};1H${ESC}2K`);
    }
    this.menuLines = [];
    this.layout = this.computeLayout();
    this.menuFrame.reset();
    this.promptFrame.reset();
    this.statusFrame.reset();
    this.out.write(`${ESC}r`);
    this.clearPrompt();
    this.clearStatus();
    this.out.write(`${ESC}${this.layout.regionBottom};1H`);
  }

  resume(): void {
    if (!this.enabled) return;
    // A command can print past the bottom of the screen while the region is off,
    // which scrolls the whole screen and corrupts both the header and the footer.
    // Repainting all three from scratch is the only way back to a known state.
    this.statusFrame.reset();
    this.menuFrame.reset();
    this.promptFrame.reset();
    this.clearStatus();
    this.clearPrompt();
    this.applyRegion();
    this.drawHeader();
    this.moveToRegionBottom();
    this.drawStatus();
  }

  /**
   * Settles the footer at the end of a turn.
   *
   * Any coalesced frame is written immediately (cancelling its timer) and the
   * cursor is made visible again. FrameRenderer always opens and closes DEC
   * mode 2026 inside one write, so there is no synchronised update left open
   * across ticks for the terminal to freeze on.
   */
  finishTurn(): void {
    if (!this.enabled) return;
    this.statusFrame.flush();
    this.menuFrame.flush();
    this.promptFrame.flush();
    this.out.write("\u001b[?25h");
  }

  /** Restores the terminal and prints the closing line. */
  disable(finalLine?: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.out.write(`${ESC}r`);
    const { statusRow, promptRow } = this.layout;
    // The menu rows sit above the status line; wipe them so the closing line does
    // not land on top of a stale completion list.
    const { menuTop, menuRows } = this.layout;
    for (let index = 0; index < menuRows; index++) {
      this.out.write(`${ESC}${menuTop + index};1H${ESC}2K`);
    }
    this.out.write(`${ESC}${statusRow};1H${ESC}2K`);
    this.out.write(`${ESC}${promptRow};1H${ESC}2K`);
    if (finalLine !== undefined) this.out.write(`${ESC}${promptRow};1H${finalLine}\n`);
    else this.out.write(`${ESC}${promptRow};1H\n`);
    this.statusFrame.dispose();
    this.menuFrame.dispose();
    this.promptFrame.dispose();
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
