import pc from "picocolors";
import { terminalDimension, visibleWidth } from "./Text.js";
import { FrameRenderer } from "./FrameRenderer.js";
import { Viewport } from "./Viewport.js";

const ESC = "\u001b[";
const SAVE = "\u001b7";
const RESTORE = "\u001b8";
const ENTER_ALT = "\u001b[?1049h";
const LEAVE_ALT = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";
const ENABLE_PASTE = "\u001b[?2004h";
const DISABLE_PASTE = "\u001b[?2004l";
const CLEAR = "\u001b[2J\u001b[H";

export interface ChromeLayout {
  /** Rows occupied by the fixed header, 1-based. */
  headerRows: number;
  /** Row holding the tab strip, or 0 when tabs are not shown. */
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
  /** First row of the full-screen composer box. */
  composerTop: number;
  /** Rows occupied by the composer box. */
  composerRows: number;
  /** Columns available to conversation lines, excluding the scrollbar. */
  contentWidth: number;
  /** 1-based divider column for the split inspector, or 0 when hidden. */
  dividerColumn: number;
  /** Columns reserved by the inspector. */
  sidebarWidth: number;
}

export interface ChromeEnableOptions {
  /** Enter the alternate screen with the full coordinate-based layout. */
  fullscreen?: boolean;
  /** Compact one-line header used in fullscreen mode. */
  header?: string;
}

type WriteFn = (chunk: unknown, ...args: unknown[]) => boolean;

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
  private fullscreenMode = false;
  private headerLines: string[] = [];
  private headerText = "";
  private statusText = "";
  /** One line of tab labels, or undefined when the strip is hidden. */
  private tabStrip: string | undefined;
  /** Completion menu rows, drawn just above the composer. */
  private menuLines: string[] = [];
  private sidebarLines: string[] | undefined;
  private composerMode = "ask";
  private readonly out: NodeJS.WriteStream;
  /** Frame sink that bypasses the stderr capture in fullscreen mode. */
  private readonly frameOut: NodeJS.WriteStream;
  /** Diffing writers for the three regions that change while the TUI runs. */
  private readonly statusFrame: FrameRenderer;
  private readonly menuFrame: FrameRenderer;
  private readonly promptFrame: FrameRenderer;
  private scrollport: Viewport | undefined;
  private viewportTimer: NodeJS.Timeout | undefined;
  private inputListener: ((chunk: Buffer | string) => void) | undefined;
  private mouseBuffer = "";
  private suspended = false;
  /** True while a selector temporarily handed us back the normal buffer. */
  private altSuspended = false;
  private originalWrite: WriteFn | undefined;
  private hadOwnWrite = false;
  private ownWrite: unknown;
  private lastPrompt: { promptText: string; buffer: string; cursor: number } | undefined;

  constructor(out: NodeJS.WriteStream = process.stderr) {
    this.out = out;
    // The frame sink always writes straight to the terminal: the interactive
    // writer in front of `out` would otherwise feed frames back into the
    // virtual viewport.
    this.frameOut = {
      get isTTY() {
        return out.isTTY;
      },
      get columns() {
        return out.columns;
      },
      get rows() {
        return out.rows;
      },
      write: (chunk: string | Uint8Array): boolean => {
        this.rawWrite(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    this.statusFrame = new FrameRenderer(this.frameOut, { coalesce: false });
    this.menuFrame = new FrameRenderer(this.frameOut, { coalesce: false });
    this.promptFrame = new FrameRenderer(this.frameOut, { coalesce: false });
  }

  static supported(out: NodeJS.WriteStream = process.stderr): boolean {
    return out.isTTY === true;
  }

  get active(): boolean {
    return this.enabled;
  }

  get fullscreen(): boolean {
    return this.fullscreenMode;
  }

  /** Virtual scrollback, exposed for viewport tests and the inspector. */
  get viewport(): Viewport | undefined {
    return this.scrollport;
  }

  /** Draws the header and reserves the conversation area. */
  enable(headerLines: string[], options: ChromeEnableOptions = {}): ChromeLayout | undefined {
    if (!Chrome.supported(this.out)) return undefined;
    this.enabled = true;
    this.fullscreenMode = options.fullscreen === true;
    this.headerLines = headerLines;
    this.headerText = options.header ?? headerLines.join(" ");

    if (this.fullscreenMode) {
      this.scrollport = new Viewport();
      this.altSuspended = false;
      this.installWriter();
      this.installMouse();
      this.write(`${ENTER_ALT}${CLEAR}${ENABLE_MOUSE}${ENABLE_PASTE}${HIDE_CURSOR}`);
      this.layout = this.computeLayout();
      this.applyFullscreenSize();
      this.drawHeader();
      this.renderViewport();
      this.drawStatus();
      return this.layout;
    }

    this.write(HIDE_CURSOR);
    this.layout = this.computeLayout();
    this.drawHeader();
    this.applyRegion();
    this.moveToRegionBottom();
    this.write(SHOW_CURSOR);
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
    composerTop: 1,
    composerRows: 1,
    contentWidth: 79,
    dividerColumn: 0,
    sidebarWidth: 0,
  };

  current(): ChromeLayout {
    return this.layout;
  }

  setHeader(text: string): void {
    this.headerText = text;
    if (this.enabled && !this.suspended) this.drawHeader();
  }

  setComposerMode(mode: string): void {
    if (this.composerMode === mode) return;
    this.composerMode = mode;
    if (this.enabled && !this.suspended && this.fullscreenMode && this.lastPrompt !== undefined) {
      this.drawPrompt(this.lastPrompt.promptText, this.lastPrompt.buffer, this.lastPrompt.cursor);
    }
  }

  /** Top row for a bottom dock panel of `height` rows. */
  wizardOrigin(height: number): number {
    if (this.fullscreenMode) {
      return Math.max(2, this.layout.composerTop - Math.max(1, height) - 1);
    }
    return Math.max(1, this.layout.height - Math.max(1, height) - 1);
  }

  private computeLayout(): ChromeLayout {
    const width = terminalDimension(this.out.columns);
    if (this.fullscreenMode) {
      const rows = terminalDimension(this.out.rows, 24);
      const height = Math.max(12, rows);
      const composerRows = 3;
      const statusRow = height;
      const composerTop = Math.max(3, height - composerRows);
      const promptRow = composerTop + 1;
      const maxMenuRows = Math.max(0, composerTop - 3);
      const menuRows = Math.min(this.menuLines.length, maxMenuRows);
      const menuTop = menuRows > 0 ? composerTop - menuRows : 0;
      const regionTop = 2;
      const regionBottom = Math.max(regionTop, (menuRows > 0 ? menuTop : composerTop) - 1);
      const sidebarWidth =
        this.sidebarLines !== undefined
          ? Math.min(Math.max(10, Math.floor(width * 0.3)), Math.max(10, width - 20))
          : 0;
      const dividerColumn = sidebarWidth > 0 ? Math.max(1, width - sidebarWidth) : 0;
      const available = dividerColumn > 0 ? dividerColumn - 2 : width - 1;
      const contentWidth = Math.max(1, Math.min(width - 1, available));
      return {
        headerRows: 1,
        tabRow: 0,
        regionTop,
        regionBottom,
        statusRow,
        promptRow,
        menuTop,
        menuRows,
        height,
        composerTop,
        composerRows,
        contentWidth,
        dividerColumn,
        sidebarWidth,
      };
    }

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
    return {
      headerRows,
      tabRow,
      regionTop,
      regionBottom,
      statusRow,
      promptRow,
      menuTop,
      menuRows,
      height,
      composerTop: promptRow,
      composerRows: 1,
      contentWidth: width,
      dividerColumn: 0,
      sidebarWidth: 0,
    };
  }

  /** Recomputes after a terminal resize. */
  resize(): void {
    if (!this.enabled) return;
    this.layout = this.computeLayout();
    // Every origin moved, so the previous frame buffers describe the wrong rows.
    this.statusFrame.reset();
    this.menuFrame.reset();
    this.promptFrame.reset();
    if (this.fullscreenMode) {
      this.applyFullscreenSize();
      this.write(CLEAR);
      this.drawHeader();
      this.renderViewport();
      this.drawMenu();
      this.drawStatus();
      if (this.lastPrompt !== undefined) {
        this.drawPrompt(this.lastPrompt.promptText, this.lastPrompt.buffer, this.lastPrompt.cursor);
      }
      return;
    }
    this.drawHeader();
    this.applyRegion();
    this.moveToRegionBottom();
    this.drawMenu();
    this.drawStatus();
  }

  private drawHeader(): void {
    if (this.fullscreenMode) {
      const width = terminalDimension(this.out.columns);
      this.write(`${ESC}1;1H${ESC}2K${fit(this.headerText, width)}`);
      return;
    }
    // Only `layout.headerRows` lines may be painted: on a short terminal that
    // budget is smaller than the banner, and drawing the overflow would land on
    // the tab strip's row and erase it.
    for (let index = 0; index < this.layout.headerRows; index++) {
      const line = this.headerLines[index] ?? "";
      this.write(`${ESC}${index + 1};1H${ESC}2K${line}`);
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
    if (this.fullscreenMode) {
      // The REPL folds the active tab into the one-row header.
      return;
    }
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
    this.write(`${ESC}${this.layout.tabRow};1H${ESC}2K${line}`);
  }

  private applyRegion(): void {
    if (this.fullscreenMode) return;
    const { regionTop, regionBottom } = this.layout;
    this.write(`${ESC}${regionTop};${regionBottom}r`);
  }

  /** Puts the cursor at the bottom of the conversation region. */
  moveToRegionBottom(): void {
    if (!this.enabled) return;
    this.write(`${ESC}${this.layout.regionBottom};1H`);
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
    if (this.fullscreenMode) {
      this.scrollport?.append(text);
      this.scheduleViewport();
      return;
    }
    this.write(text);
  }

  /** Appends pre-rendered lines to the virtual stream. */
  writeBlock(lines: readonly string[]): void {
    if (!this.enabled) {
      this.out.write(`${lines.join("\n")}\n`);
      return;
    }
    if (this.fullscreenMode) {
      this.scrollport?.appendLines(lines);
      this.scheduleViewport();
      return;
    }
    this.write(`${lines.join("\n")}\n`);
  }

  /** Replaces the split inspector content; undefined hides the pane. */
  setSidebar(lines: string[] | undefined): void {
    this.sidebarLines = lines;
    if (!this.enabled || !this.fullscreenMode) return;
    this.layout = this.computeLayout();
    this.applyFullscreenSize();
    this.renderViewport();
    this.drawMenu();
    this.drawStatus();
    if (this.lastPrompt !== undefined) {
      this.drawPrompt(this.lastPrompt.promptText, this.lastPrompt.buffer, this.lastPrompt.cursor);
    }
  }

  private applyFullscreenSize(): void {
    this.scrollport?.setSize(
      this.layout.contentWidth,
      Math.max(1, this.layout.regionBottom - this.layout.regionTop + 1),
    );
  }

  private scheduleViewport(): void {
    if (!this.fullscreenMode || this.suspended || this.viewportTimer !== undefined) return;
    this.viewportTimer = setTimeout(() => {
      this.viewportTimer = undefined;
      this.renderViewport();
    }, 16);
    this.viewportTimer.unref?.();
  }

  private renderViewport(): void {
    if (!this.fullscreenMode || this.suspended || this.scrollport === undefined) return;
    const rows = Math.max(1, this.layout.regionBottom - this.layout.regionTop + 1);
    const visible = this.scrollport.visible(rows);
    const bar = this.scrollport.scrollbar(rows);
    const contentWidth = this.layout.contentWidth;
    const divider = this.layout.dividerColumn;
    const width = terminalDimension(this.out.columns);
    for (let index = 0; index < rows; index++) {
      const row = this.layout.regionTop + index;
      const line = fit(visible[index] ?? "", contentWidth);
      this.write(`${ESC}${row};1H${ESC}2K${line}`);
      this.write(`${ESC}${row};${Math.min(width, contentWidth + 1)}H${bar[index] ?? "│"}`);
      if (divider > 0) {
        const sidebar = this.sidebarLines?.[index] ?? "";
        this.write(
          `${ESC}${row};${divider}H${ESC}2K${pc.gray("│")} ${fit(sidebar, Math.max(1, width - divider - 1))}`,
        );
      }
    }
    const pill = this.scrollport.pill();
    if (pill !== undefined) {
      this.write(`${ESC}${this.layout.regionBottom};1H${ESC}2K${fit(pc.gray(pill), width)}`);
    }
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
        this.write(`${ESC}${hadTop + index};1H${ESC}2K`);
      }
      this.layout = this.computeLayout();
      this.menuFrame.reset();
      if (this.fullscreenMode) {
        this.applyFullscreenSize();
        this.renderViewport();
        this.drawHeader();
      } else {
        this.applyRegion();
        this.moveToRegionBottom();
      }
    }
    this.drawMenu();
    if (this.fullscreenMode) this.drawStatus();
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
    if (!this.enabled || this.suspended) return;
    const { statusRow } = this.layout;
    const width = terminalDimension(this.out.columns);
    const body = fit(this.statusText, width);
    if (this.fullscreenMode) {
      this.write(`${ESC}${statusRow};1H${ESC}2K${body}`);
      return;
    }
    // The cursor must come back to the conversation region: the status frame is
    // positioned absolutely, and leaving it there would send the next write to
    // the footer row.
    this.write(SAVE);
    this.statusFrame.render([body], { originRow: statusRow });
    this.write(RESTORE);
  }

  /** Draws the composer; full-screen uses a three-row mode-colored box. */
  drawPrompt(promptText: string, buffer: string, cursor: number): void {
    if (!this.enabled) return;
    this.lastPrompt = { promptText, buffer, cursor };
    const width = terminalDimension(this.out.columns);
    if (!this.fullscreenMode) {
      const { promptRow } = this.layout;
      // An empty prompt shows what it accepts instead of a bare glyph; the cursor
      // still sits right after the prompt, so the placeholder never gets in the way.
      const ghost = buffer.length === 0 ? pc.gray("ask for a change, or / for commands") : "";
      const line = fit(`${promptText}${buffer}${ghost}`, width);
      this.promptFrame.render([line], { originRow: promptRow });
      const used = visibleWidth(promptText) + cursor;
      const column = Math.min(width - 1, used) + 1;
      this.write(`${ESC}${promptRow};${column}H`);
      return;
    }

    const { composerTop, promptRow } = this.layout;
    if (width < 8) {
      const line = fit(`${promptText}${buffer}`, width);
      this.promptFrame.render([line], { originRow: promptRow });
      this.write(`${ESC}${promptRow};${Math.min(width, visibleWidth(promptText) + cursor + 1)}H${SHOW_CURSOR}`);
      return;
    }
    const border = modePaint(this.composerMode);
    const label = ` ${this.composerMode.toUpperCase()} `;
    const topFill = "─".repeat(Math.max(0, width - 3 - label.length));
    const innerWidth = Math.max(1, width - 4);
    const ghost = buffer.length === 0 ? pc.gray("ask for a change, or / for commands") : "";
    const text = fit(`${promptText}${buffer}${ghost}`, innerWidth);
    const top = `${border("╭─")}${border(label)}${border(topFill)}${border("╮")}`;
    const middle = `${border("│")} ${padAnsi(text, innerWidth)} ${border("│")}`;
    const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
    this.promptFrame.render([top, middle, bottom], { originRow: composerTop });
    const used = visibleWidth(promptText) + cursor;
    const column = Math.min(width - 2, Math.max(3, used + 3));
    this.write(`${ESC}${promptRow};${column}H${SHOW_CURSOR}`);
  }

  /** Clears the input row, or the three-row composer box. */
  clearPrompt(): void {
    if (!this.enabled) return;
    this.lastPrompt = undefined;
    this.promptFrame.clear();
    if (this.fullscreenMode) {
      for (let row = this.layout.composerTop; row < this.layout.composerTop + this.layout.composerRows; row++) {
        this.write(`${ESC}${row};1H${ESC}2K`);
      }
      return;
    }
    this.write(`${ESC}${this.layout.promptRow};1H${ESC}2K`);
  }

  /** Clears the reserved status row. */
  private clearStatus(): void {
    if (!this.enabled) return;
    this.statusFrame.clear();
    this.write(`${ESC}${this.layout.statusRow};1H${ESC}2K`);
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
    this.suspended = true;
    if (this.fullscreenMode) {
      // A selector would otherwise nest its own `?1049h` inside ours; leaving
      // the alternate buffer first keeps its exit returning to the normal one.
      this.altSuspended = true;
      this.write(`${DISABLE_MOUSE}${LEAVE_ALT}${ESC}r`);
      return;
    }
    // The menu belongs to the prompt line, and the caller is about to hand the
    // screen to a full-screen selector. Clear its rows first (using the current
    // layout, which still knows where they are) and give the space back.
    const { menuTop, menuRows } = this.layout;
    for (let index = 0; index < menuRows; index++) {
      this.write(`${ESC}${menuTop + index};1H${ESC}2K`);
    }
    this.menuLines = [];
    this.layout = this.computeLayout();
    this.menuFrame.reset();
    this.promptFrame.reset();
    this.statusFrame.reset();
    this.write(`${ESC}r`);
    this.clearPrompt();
    this.clearStatus();
    this.write(`${ESC}${this.layout.regionBottom};1H`);
  }

  resume(): void {
    if (!this.enabled) return;
    this.suspended = false;
    if (this.fullscreenMode) {
      this.layout = this.computeLayout();
      this.statusFrame.reset();
      this.menuFrame.reset();
      this.promptFrame.reset();
      this.applyFullscreenSize();
      if (this.altSuspended) {
        this.write(`${ENTER_ALT}${CLEAR}${ENABLE_MOUSE}`);
        this.altSuspended = false;
      } else {
        this.write(CLEAR);
      }
      this.drawHeader();
      this.renderViewport();
      this.drawMenu();
      this.drawStatus();
      if (this.lastPrompt !== undefined) {
        this.drawPrompt(this.lastPrompt.promptText, this.lastPrompt.buffer, this.lastPrompt.cursor);
      }
      return;
    }
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

  /** Settles the frame writers at the end of a turn and shows the cursor. */
  finishTurn(): void {
    if (!this.enabled) return;
    if (this.fullscreenMode) {
      this.scrollport?.flushPending();
      if (this.viewportTimer !== undefined) {
        clearTimeout(this.viewportTimer);
        this.viewportTimer = undefined;
      }
      this.renderViewport();
    }
    this.statusFrame.flush();
    this.menuFrame.flush();
    this.promptFrame.flush();
    this.write(SHOW_CURSOR);
  }

  /** Scroll keys owned by the viewport rather than the prompt editor. */
  handleScrollKey(
    key: { name?: string | undefined; shift?: boolean | undefined; ctrl?: boolean | undefined },
    emptyBuffer: boolean,
  ): boolean {
    if (!this.enabled || !this.fullscreenMode || this.suspended || this.scrollport === undefined) return false;
    const name = key.name ?? "";
    let handled = true;
    if (name === "pageup" || (key.ctrl === true && name === "u" && emptyBuffer)) {
      this.scrollport.pageUp();
    } else if (name === "pagedown") {
      this.scrollport.pageDown();
    } else if (name === "end" && emptyBuffer) {
      this.scrollport.toBottom();
    } else if ((name === "up" || name === "down") && key.shift === true) {
      if (name === "up") this.scrollport.scrollUp(3);
      else this.scrollport.scrollDown(3);
    } else {
      handled = false;
    }
    if (handled) this.renderViewport();
    return handled;
  }

  /** SGR mouse sequences: wheel up is button 64, wheel down is 65. */
  handleMouse(sequence: string): boolean {
    if (!this.enabled || !this.fullscreenMode || this.scrollport === undefined) return false;
    let handled = false;
    const pattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
    for (const match of sequence.matchAll(pattern)) {
      const button = Number.parseInt(match[1] ?? "", 10);
      if (button === 64) {
        this.scrollport.scrollUp(3);
        handled = true;
      } else if (button === 65) {
        this.scrollport.scrollDown(3);
        handled = true;
      }
    }
    if (handled) this.renderViewport();
    return handled;
  }

  /** Restores every terminal mode, then leaves the alternate buffer. */
  disable(finalLine?: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    const wasFullscreen = this.fullscreenMode;
    this.fullscreenMode = false;
    this.removeMouse();
    if (this.viewportTimer !== undefined) {
      clearTimeout(this.viewportTimer);
      this.viewportTimer = undefined;
    }
    if (wasFullscreen) {
      const altExit = this.altSuspended ? "" : LEAVE_ALT;
      this.write(`${DISABLE_MOUSE}${DISABLE_PASTE}\u001b[?2026l${altExit}${SHOW_CURSOR}${ESC}r`);
      this.altSuspended = false;
      this.suspended = false;
      this.restoreWriter();
      this.scrollport = undefined;
      this.statusFrame.dispose();
      this.menuFrame.dispose();
      this.promptFrame.dispose();
      if (finalLine !== undefined) this.out.write(`${finalLine}\n`);
      return;
    }
    this.write(`${ESC}r`);
    const { statusRow, promptRow } = this.layout;
    // The menu rows sit above the status line; wipe them so the closing line does
    // not land on top of a stale completion list.
    const { menuTop, menuRows } = this.layout;
    for (let index = 0; index < menuRows; index++) {
      this.write(`${ESC}${menuTop + index};1H${ESC}2K`);
    }
    this.write(`${ESC}${statusRow};1H${ESC}2K`);
    this.write(`${ESC}${promptRow};1H${ESC}2K`);
    if (finalLine !== undefined) this.write(`${ESC}${promptRow};1H${finalLine}\n`);
    else this.write(`${ESC}${promptRow};1H\n`);
    this.statusFrame.dispose();
    this.menuFrame.dispose();
    this.promptFrame.dispose();
  }

  private write(text: string): void {
    this.rawWrite(text);
  }

  private rawWrite(text: string): void {
    if (this.originalWrite !== undefined) {
      this.originalWrite(text);
      return;
    }
    this.out.write(text);
  }

  /**
   * Captures direct stderr writes (print helpers, Markdown, tool output) while
   * full-screen. Chrome's own frames use rawWrite, so they never loop back.
   */
  private installWriter(): void {
    if (this.originalWrite !== undefined) return;
    const stream = this.out as unknown as { write: WriteFn };
    this.originalWrite = stream.write.bind(this.out) as WriteFn;
    this.hadOwnWrite = Object.prototype.hasOwnProperty.call(this.out, "write");
    this.ownWrite = stream.write;
    stream.write = ((chunk: unknown, ...args: unknown[]): boolean => {
      if (!this.fullscreenMode || this.suspended) {
        return this.originalWrite?.(chunk, ...args) ?? true;
      }
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      // The crash/exit restore hook must reach the real terminal even while the
      // viewport still owns stderr; otherwise its alt/mouse reset is swallowed.
      if (text.includes("\u001b[?1049l") || text.includes("\u001b[?1006l")) {
        return this.originalWrite?.(text, ...args) ?? true;
      }
      this.scrollport?.append(text);
      this.scheduleViewport();
      return true;
    }) as WriteFn;
  }

  private restoreWriter(): void {
    if (this.originalWrite === undefined) return;
    const stream = this.out as unknown as { write: unknown };
    if (this.hadOwnWrite) stream.write = this.ownWrite;
    else delete stream.write;
    this.originalWrite = undefined;
  }

  private installMouse(): void {
    const input = process.stdin as unknown as {
      on?: (event: string, listener: (chunk: Buffer | string) => void) => void;
    };
    if (typeof input.on !== "function" || this.inputListener !== undefined) return;
    this.inputListener = (chunk: Buffer | string): void => {
      if (!this.fullscreenMode || this.suspended) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.mouseBuffer = `${this.mouseBuffer}${text}`;
      this.handleMouse(this.mouseBuffer);
      // Keep only a possible split SGR prefix; regular keys are ignored here.
      const lastEscape = this.mouseBuffer.lastIndexOf("\u001b");
      this.mouseBuffer = lastEscape >= 0 ? this.mouseBuffer.slice(lastEscape) : "";
    };
    input.on("data", this.inputListener);
  }

  private removeMouse(): void {
    if (this.inputListener === undefined) return;
    const input = process.stdin as unknown as {
      off?: (event: string, listener: (chunk: Buffer | string) => void) => void;
      removeListener?: (event: string, listener: (chunk: Buffer | string) => void) => void;
    };
    input.off?.("data", this.inputListener);
    input.removeListener?.("data", this.inputListener);
    this.inputListener = undefined;
    this.mouseBuffer = "";
  }
}

function modePaint(mode: string): (text: string) => string {
  switch (mode) {
    case "plan":
      return pc.cyan;
    case "ask":
    case "pair":
      return pc.yellow;
    case "auto":
    case "build":
      return pc.green;
    case "yolo":
      return pc.red;
    default:
      return pc.green;
  }
}

/** Pads visible ANSI text to exactly `width` columns. */
function padAnsi(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible >= width ? fit(text, width) : `${text}${" ".repeat(width - visible)}`;
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
