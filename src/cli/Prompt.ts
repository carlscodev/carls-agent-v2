import * as readline from "node:readline";
import pc from "picocolors";
import type { Chrome } from "./Chrome.js";
import { claimKeypress, isMouseFragment } from "./Input.js";
import { applyCompletion, complete, type Completion, type CompletionResult } from "./Autocomplete.js";
import type { Runtime } from "../core/Runtime.js";
import { theme } from "./Theme.js";

/** Result of reading one prompt line. */
export type PromptResult =
  | { type: "line"; text: string }
  | { type: "interrupt" }
  | { type: "eof" }
  | { type: "mode-cycle" }
  | { type: "help" }
  | { type: "palette"; filter?: string }
  /** Ctrl+T: start a new session tab. */
  | { type: "new-tab" }
  /** Ctrl+X: close the active session tab. */
  | { type: "close-tab" }
  /** Ctrl+N: move to the next session tab. */
  | { type: "next-tab" }
  /** Ctrl+B: toggle the session sidebar. */
  | { type: "sidebar" }
  /** The user typed `@` at the start of a word, asking for a file mention. */
  | { type: "mention"; draft: string };

interface PromptOptions {
  prompt: string;
  /** Text to start editing with, so a mention can resume the same line. */
  initial?: string;
  history?: string[];
  /** Called when the user cycles the permission mode with Shift+Tab. */
  onModeCycle?: () => string | undefined;
  /** When set, the input line is drawn in the fixed footer instead of inline. */
  chrome?: Chrome;
  /** Called when the user asks for the command palette (Ctrl+P or a bare `/`). */
  onPalette?: (filter: string) => boolean;
  /** Set to false to type `@` literally (handled by the REPL when picking files). */
  mentions?: boolean;
  /** Enables the completion menu; needs the runtime to know models and skills. */
  runtime?: Runtime;
  /** Called on Ctrl+O to expand the last collapsed tool output. */
  onExpand?: () => void;
  /** Full-screen viewport scroll keys. Return true when consumed. */
  onScrollKey?: (key: readline.Key, emptyBuffer: boolean) => boolean;
}

/** Colour per completion kind, so commands and paths read as different things. */
function kindColor(kind: Completion["kind"]): (text: string) => string {
  const t = theme();
  switch (kind) {
    case "command":
      return (text: string) => t.paint(t.colors.accent, text);
    case "skill":
      return (text: string) => t.paint(t.categorical(4), text);
    case "model":
      return (text: string) => t.paint(t.categorical(2), text);
    case "file":
      return (text: string) => t.paint(t.colors.markdown.linkText, text);
    default:
      return (text: string) => t.paint(t.colors.text.base, text);
  }
}

/**
 * Single-line prompt editor with raw-mode key handling.
 *
 * Node's readline cannot report Shift+Tab and inserts unknown escape sequences
 * into the buffer, so the REPL owns the line itself. This also means only one
 * component ever reads stdin, which is what keeps selectors from swallowing
 * keystrokes.
 */
export class Prompt {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly history: string[];
  private buffer = "";
  private cursor = 0;
  private historyIndex = 0;
  private draft = "";
  /** Open completion menu, or undefined when hidden. */
  private menu: { result: CompletionResult; index: number; navigated: boolean } | undefined;

  constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr) {
    this.input = input;
    this.output = output;
    this.history = [];
  }

  static supports(input: NodeJS.ReadStream): boolean {
    return input.isTTY === true && typeof input.setRawMode === "function";
  }

  /** Reads one line. Never rejects; every exit path is a typed result. */
  async read(options: PromptOptions): Promise<PromptResult> {
    const wasRaw = this.input.isRaw === true;
    this.input.setRawMode?.(true);
    this.input.resume();
    this.buffer = options.initial ?? "";
    this.cursor = this.buffer.length;
    this.historyIndex = this.history.length;
    this.draft = "";

    return await new Promise<PromptResult>((resolve) => {
      let settled = false;
      let releaseKeypress: (() => void) | undefined;
      const finish = (result: PromptResult): void => {
        if (settled) return;
        settled = true;
        releaseKeypress?.();
        releaseKeypress = undefined;
        this.input.setRawMode?.(wasRaw);
        // Never pause: the steering composer or the next prompt must inherit a
        // live stream. On Windows/ConPTY a pause here can leave the keyboard
        // unread even after the next resume().
        this.input.resume();
        // The menu occupies real rows above the status line; leaving it up would
        // strand it there once the line is submitted.
        this.menu = undefined;
        options.chrome?.clearMenu();
        options.chrome?.clearPrompt();
        if (options.chrome === undefined) this.output.write("\r\u001b[K");
        if (result.type === "line" && result.text.trim().length > 0) {
          this.history.push(result.text);
        }
        resolve(result);
      };

      const render = (): void => {
        if (options.chrome !== undefined) {
          options.chrome.drawPrompt(options.prompt, this.buffer, this.cursor);
          refreshMenu();
          return;
        }
        this.output.write(`\r\u001b[K${options.prompt}${this.buffer}`);
        const back = this.buffer.length - this.cursor;
        if (back > 0) this.output.write(`\u001b[${back}D`);
        refreshMenu();
      };

      /** Recomputes the completion menu for the current buffer. */
      const refreshMenu = (): void => {
        const runtime = options.runtime;
        if (runtime === undefined) {
          this.menu = undefined;
          options.chrome?.clearMenu();
          return;
        }
        const result = complete({ line: this.buffer, cursor: this.cursor, runtime });
        this.menu = result === undefined ? undefined : { result, index: 0, navigated: false };
        if (this.menu === undefined) options.chrome?.clearMenu();
        else options.chrome?.setMenu(renderMenu());
      };

      /** Paints the visible slice of the menu, cursor row highlighted. */
      const renderMenu = (): string[] => {
        if (this.menu === undefined) return [];
        const t = theme();
        const items = this.menu.result.items;
        const window = 8;
        const start = Math.max(0, Math.min(this.menu.index - Math.floor(window / 2), items.length - window));
        const slice = items.slice(start, start + window);
        const lines = slice.map((item, offset) => {
          const active = start + offset === this.menu?.index;
          const glyph = active ? t.paint(t.colors.accent, "❯") : " ";
          const label = active ? t.bold(item.label) : item.label;
          const detail = item.detail !== undefined ? `  ${t.paint(t.colors.text.faint, item.detail)}` : "";
          return `${glyph} ${kindColor(item.kind)(label)}${detail}`;
        });
        if (items.length > window) {
          lines.push(t.paint(t.colors.text.faint, `  ${this.menu.index + 1}/${items.length} · ↑↓ select · tab accept · esc close`));
        } else {
          lines.push(t.paint(t.colors.text.faint, "  ↑↓ select · tab accept · esc close"));
        }
        return lines;
      };

      const accept = (): boolean => {
        if (this.menu === undefined) return false;
        const chosen: Completion | undefined = this.menu.result.items[this.menu.index];
        if (chosen === undefined) return false;
        const next = applyCompletion(this.buffer, this.cursor, this.menu.result, chosen);
        this.buffer = next.line;
        this.cursor = next.cursor;
        this.menu = undefined;
        options.chrome?.clearMenu();
        render();
        return true;
      };

      const closeMenu = (): void => {
        if (this.menu === undefined) return;
        this.menu = undefined;
        options.chrome?.clearMenu();
      };

      const moveMenu = (direction: number): boolean => {
        if (this.menu === undefined) return false;
        const count = this.menu.result.items.length;
        if (count === 0) return false;
        this.menu.index = (this.menu.index + direction + count) % count;
        this.menu.navigated = true;
        options.chrome?.setMenu(renderMenu());
        return true;
      };

      /** Wraps the caret to the end of the buffer, menu closed. */
      const moveCaretEnd = (): void => {
        closeMenu();
        this.cursor = this.buffer.length;
        render();
      };

      const onKey = (sequence: string | undefined, key: readline.Key): void => {
        if (settled) return;
        const name = key.name ?? "";
        const seq = sequence ?? key.sequence ?? "";

        // PageUp/PageDown/Shift+arrows/End belong to the virtual viewport in the
        // full-screen layout, not to the line editor.
        if (options.onScrollKey?.(key, this.buffer.length === 0) === true) return;

        if (key.ctrl === true) {
          switch (name) {
            case "c":
              finish({ type: "interrupt" });
              return;
            case "d":
              if (this.buffer.length === 0) finish({ type: "eof" });
              else finish({ type: "line", text: this.buffer });
              return;
            case "o":
              // Ctrl+O expands the last collapsed block; the prompt is redrawn
              // afterwards because the expansion prints above the footer.
              options.onExpand?.();
              render();
              return;
            case "a":
              this.cursor = 0;
              render();
              return;
            case "e":
              this.cursor = this.buffer.length;
              render();
              return;
            case "u":
              this.buffer = this.buffer.slice(this.cursor);
              this.cursor = 0;
              render();
              return;
            case "k":
              this.buffer = this.buffer.slice(0, this.cursor);
              render();
              return;
            case "w":
              this.deleteWord();
              render();
              return;
            case "t":
              finish({ type: "new-tab" });
              return;
            case "x":
              finish({ type: "close-tab" });
              return;
            case "n":
              finish({ type: "next-tab" });
              return;
            case "b":
              finish({ type: "sidebar" });
              return;
            case "l":
              this.output.write("\u001b[2J\u001b[H");
              render();
              return;
            case "p": {
              // Ctrl+P is the conventional palette binding; fall through to the
              // REPL, which owns the full-screen list.
              if (options.onPalette?.(this.buffer) === true) {
                finish({ type: "palette", filter: this.buffer });
                return;
              }
              return;
            }
            default:
              return;
          }
        }

        // Shift+Tab arrives as the CSI Z sequence.
        if (seq === "\u001b[Z" || (name === "tab" && key.shift === true)) {
          // The footer already carries the mode, so cycling it only needs the
          // status line repainted. Writing a note into the conversation left a
          // stray line behind on every press.
          options.onModeCycle?.();
          render();
          return;
        }

        // The completion menu owns the arrow keys and Tab while it is open, so
        // history recall and literal tabs resume once it closes.
        if (this.menu !== undefined) {
          if (name === "up" && moveMenu(-1)) return;
          if (name === "down" && moveMenu(1)) return;
          if (name === "tab") {
            accept();
            return;
          }
          if (name === "escape") {
            closeMenu();
            return;
          }
          if ((name === "return" || name === "enter") && this.buffer.trim() !== "/") {
            // Enter only takes the highlighted row when the user has actually
            // chosen one with the arrows. Accepting the default on Enter would
            // rewrite `/doctor` into `/doctor src/cli/Doctor.ts` as the user
            // submits, which is never what they asked for.
            if (this.menu.navigated && accept()) {
              // A row was picked deliberately, so Enter runs it in one press
              // rather than leaving the completed text in the composer.
              finish({ type: "line", text: this.buffer });
              return;
            }
            closeMenu();
          }
        }

        // Tab on an empty composer cycles the agent mode in the full-screen
        // layout; the legacy inline layout keeps inserting spaces, as its tests
        // and muscle memory expect. The completion menu consumes Tab first.
        if (
          name === "tab" &&
          this.buffer.length === 0 &&
          options.onModeCycle !== undefined &&
          options.chrome?.fullscreen === true
        ) {
          options.onModeCycle();
          render();
          return;
        }

        switch (name) {
          case "return":
          case "enter":
            // A lone slash is ambiguous (every command starts with one), so it
            // opens the palette instead of erroring on an unknown command.
            if (this.buffer.trim() === "/" && options.onPalette !== undefined) {
              finish({ type: "palette" });
              return;
            }
            finish({ type: "line", text: this.buffer });
            return;
          case "backspace":
            if (this.cursor > 0) {
              this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
              this.cursor -= 1;
              render();
            }
            return;
          case "delete":
            if (this.cursor < this.buffer.length) {
              this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
              render();
            }
            return;
          case "left":
            if (this.cursor > 0) {
              this.cursor -= 1;
              render();
            }
            return;
          case "right":
            if (this.cursor < this.buffer.length) {
              this.cursor += 1;
              render();
            }
            return;
          case "home":
            this.cursor = 0;
            render();
            return;
          case "end":
            this.cursor = this.buffer.length;
            render();
            return;
          case "up":
            this.recallHistory(-1);
            render();
            return;
          case "down":
            this.recallHistory(1);
            render();
            return;
          case "tab":
            this.insert("  ");
            render();
            return;
          default:
            break;
        }

        // `@` at a word boundary asks for a file mention; the REPL owns the
        // picker, so the line is handed back with everything typed so far.
        if (seq === "@" && options.mentions !== false) {
          const before = this.buffer.slice(this.cursor - 1, this.cursor);
          if (this.cursor === 0 || /\s/.test(before)) {
            finish({ type: "mention", draft: this.buffer.slice(0, this.cursor) });
            return;
          }
        }

        if (seq.length === 0) return;
        if (seq.startsWith("\u001b")) return;
        // A second barrier for the mouse: if a report ever reaches the prompt as
        // text (a decoder that consumed the `\u001b[` prefix, a paste), it must
        // never be inserted as literal digits.
        if (isMouseFragment(seq)) return;
        const printable = seq.replace(/[\r\n]/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
        if (printable.length > 0 && !isMouseFragment(printable)) {
          this.insert(printable);
          render();
        }
      };

      releaseKeypress = claimKeypress(this.input, onKey);
      render();
    });
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private deleteWord(): void {
    const left = this.buffer.slice(0, this.cursor).replace(/\S+\s*$/, "");
    this.buffer = left + this.buffer.slice(this.cursor);
    this.cursor = left.length;
  }

  private recallHistory(direction: number): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === this.history.length) this.draft = this.buffer;
    const next = Math.min(this.history.length, Math.max(0, this.historyIndex + direction));
    this.historyIndex = next;
    this.buffer = next === this.history.length ? this.draft : (this.history[next] ?? "");
    this.cursor = this.buffer.length;
  }
}
