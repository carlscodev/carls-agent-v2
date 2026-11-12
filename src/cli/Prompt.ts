import * as readline from "node:readline";
import pc from "picocolors";
import type { Chrome } from "./Chrome.js";

/** Result of reading one prompt line. */
export type PromptResult =
  | { type: "line"; text: string }
  | { type: "interrupt" }
  | { type: "eof" }
  | { type: "mode-cycle" }
  | { type: "help" }
  | { type: "palette"; filter?: string }
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
    readline.emitKeypressEvents(this.input);
    const wasRaw = this.input.isRaw === true;
    this.input.setRawMode?.(true);
    this.input.resume();
    this.buffer = options.initial ?? "";
    this.cursor = this.buffer.length;
    this.historyIndex = this.history.length;
    this.draft = "";

    return await new Promise<PromptResult>((resolve) => {
      let settled = false;
      const finish = (result: PromptResult): void => {
        if (settled) return;
        settled = true;
        this.input.off("keypress", onKey);
        this.input.setRawMode?.(wasRaw);
        this.input.pause();
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
          return;
        }
        this.output.write(`\r\u001b[K${options.prompt}${this.buffer}`);
        const back = this.buffer.length - this.cursor;
        if (back > 0) this.output.write(`\u001b[${back}D`);
      };

      const onKey = (sequence: string | undefined, key: readline.Key): void => {
        if (settled) return;
        const name = key.name ?? "";
        const seq = sequence ?? key.sequence ?? "";

        if (key.ctrl === true) {
          switch (name) {
            case "c":
              finish({ type: "interrupt" });
              return;
            case "d":
              if (this.buffer.length === 0) finish({ type: "eof" });
              else finish({ type: "line", text: this.buffer });
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
          const label = options.onModeCycle?.();
          if (label !== undefined) {
            const note = `${pc.gray("mode →")} ${pc.bold(label)}`;
            if (options.chrome !== undefined) {
              // The cursor sits on the prompt row, so return to the conversation
              // region first; writing here would put the note under the footer,
              // where the next prompt repaint erases it.
              options.chrome.clearPrompt();
              options.chrome.moveToRegionBottom();
              options.chrome.writeRegion(`${note}\n`);
            } else {
              this.output.write(`\r\u001b[K${note}\n`);
            }
          }
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
        const printable = seq.replace(/[\r\n]/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
        if (printable.length > 0) {
          this.insert(printable);
          render();
        }
      };

      this.input.on("keypress", onKey);
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
