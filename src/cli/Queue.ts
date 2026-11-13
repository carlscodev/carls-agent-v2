import * as readline from "node:readline";
import { claimKeypress, isMouseFragment } from "./Input.js";

/**
 * Prompts typed while the agent is working.
 *
 * A turn can take minutes, and losing the thought you had while watching it is
 * worse than waiting: typing during a run now queues the message and it runs as
 * soon as the current one finishes, in order. `↑` shows the depth in the footer.
 */

export class PromptQueue {
  private readonly items: string[] = [];

  constructor(private readonly limit = 20) {}

  get length(): number {
    return this.items.length;
  }

  /** Queues a line and returns the new depth; blank lines are ignored. */
  push(text: string): number {
    const trimmed = text.trim();
    if (trimmed.length === 0) return this.items.length;
    if (this.items.length >= this.limit) return this.items.length;
    this.items.push(trimmed);
    return this.items.length;
  }

  shift(): string | undefined {
    return this.items.shift();
  }

  list(): string[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Runs every queued prompt, in order, including ones queued while draining. */
export async function drainQueue(queue: PromptQueue, run: (text: string) => Promise<void>): Promise<void> {
  for (;;) {
    const next = queue.shift();
    if (next === undefined) return;
    await run(next);
  }
}

export interface TypedLinesOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  queue: PromptQueue;
  /** Fired on Ctrl+C, which raw mode swallows instead of raising SIGINT. */
  onInterrupt?: () => void;
  glyph?: string;
  /** Repaint the typed line as characters arrive. Off when the UI owns the row. */
  echo?: boolean;
  /** Called instead of the built-in queued line, so the UI can place it. */
  onQueued?: (text: string, depth: number) => void;
  /**
   * Handles a submitted line instead of queueing it. Used for steering: the
   * message joins the running turn instead of waiting for it.
   */
  onSubmit?: (text: string) => void;
  /**
   * Fired when `Esc` is pressed with an empty composer. The REPL turns this into
   * an immediate `abort()` of the running turn, so the operator never has to wait
   * for the next step boundary to stop the agent.
   */
  onEscape?: () => void;
  /** Milliseconds to wait before treating a lone `\x1b` as a real Escape. */
  escapeDelayMs?: number;
  /**
   * Fired with the live draft on every keystroke. The chrome layout cannot use
   * the built-in `\r` echo (the footer is redrawn on a frame budget), so it
   * repaints the composer row from here instead.
   */
  onDraft?: (text: string) => void;
}

/**
 * Reads lines from the terminal while a turn runs.
 *
 * It owns stdin in raw mode for the duration, so the caller must stop it before
 * opening the prompt again. Enter queues, Escape discards what is typed, Ctrl+C
 * aborts the turn (the signal is re-raised, because raw mode eats it).
 */
export interface TypedLinesHandle {
  stop(): void;
  /** Releases stdin while another prompt owns it (an approval, for example). */
  pause(): void;
  resume(): void;
}

export function collectTypedLines(options: TypedLinesOptions): TypedLinesHandle {
  const { input, output } = options;
  const glyph = options.glyph ?? "⏳ ";
  const wasRaw = input.isRaw === true;
  input.setRawMode?.(true);
  input.resume();
  let buffer = "";
  let stopped = false;
  let paused = false;
  // A lone `\x1b` is ambiguous with the head of a CSI sequence that the terminal
  // split across chunks. readline already waits for its own escape-code timeout,
  // but a stray `[` / `A` can still arrive right after; this short confirmation
  // window lets the next key cancel the abort instead of killing a live turn.
  let escapeTimer: NodeJS.Timeout | undefined;
  const cancelEscape = (): void => {
    if (escapeTimer !== undefined) {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
  };
  const escapeDelayMs = options.escapeDelayMs ?? 30;

  const echo = options.echo !== false;
  const paint = (): void => {
    options.onDraft?.(buffer);
    if (!echo) return;
    output.write(`\r\u001b[K${glyph}${buffer}`);
  };

  const onKey = (sequence: string | undefined, key: readline.Key): void => {
    if (stopped || paused) return;
    const name = key.name ?? "";
    const seq = sequence ?? key.sequence ?? "";
    // Any key other than Escape cancels a pending abort: the `\x1b` we saw was
    // the head of a sequence (arrow, function key), not the operator asking to
    // stop the turn.
    if (name !== "escape") cancelEscape();

    if (key.ctrl === true) {
      if (name === "c") {
        // Raw mode means no SIGINT; re-raise it so the run aborts as usual.
        buffer = "";
        output.write("\r\u001b[K");
        options.onInterrupt?.();
        return;
      }
      // Every other control chord belongs to the prompt, not to this composer.
      return;
    }

    switch (name) {
      case "return":
      case "enter": {
        const text = buffer.trim();
        buffer = "";
        if (text.length === 0) {
          if (echo) output.write("\r\u001b[K");
          return;
        }
        if (options.onSubmit !== undefined) {
          if (echo) output.write("\r\u001b[K");
          options.onSubmit(text);
          return;
        }
        const depth = options.queue.push(text);
        if (options.onQueued !== undefined) {
          options.onQueued(text, depth);
        } else {
          output.write(`\r\u001b[K${glyph}queued (${depth}): ${text}\n`);
        }
        return;
      }
      case "escape":
        // A real Escape clears the draft first; a second one (or an Escape with
        // nothing typed) aborts the running turn. The short timer is what tells a
        // genuine keypress from the head of a CSI sequence split across chunks.
        cancelEscape();
        if (buffer.length > 0) {
          buffer = "";
          options.onDraft?.("");
          if (echo) output.write("\r\u001b[K");
          return;
        }
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          options.onEscape?.();
        }, escapeDelayMs);
        if (typeof escapeTimer.unref === "function") escapeTimer.unref();
        return;
      case "backspace":
        buffer = buffer.slice(0, -1);
        paint();
        return;
      default:
        break;
    }

    if (seq.length === 0 || seq.startsWith("\u001b")) return;
    // Mouse reports are not typing: a wheel turn or a click must never append
    // `64;50;8M` to the steering draft.
    if (isMouseFragment(seq)) return;
    const printable = seq.replace(/[\r\n]/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (printable.length > 0 && !isMouseFragment(printable)) {
      buffer += printable;
      paint();
    }
  };

  let releaseKeypress = claimKeypress(input, onKey);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (escapeTimer !== undefined) clearTimeout(escapeTimer);
      releaseKeypress();
      input.setRawMode?.(wasRaw);
      // The next prompt inherits the stream; pausing here was what could leave
      // a ConPTY reader deaf after the first turn.
      input.resume();
      if (echo) output.write("\r\u001b[K");
    },
    pause() {
      paused = true;
      // Hand the route to whatever owns the terminal now (the ask_user box or
      // an approval line). The listener stays installed once, in the router.
      releaseKeypress();
    },
    resume() {
      paused = false;
      releaseKeypress();
      releaseKeypress = claimKeypress(input, onKey);
      // A widget that took stdin (the ask_user box, an approval prompt) pauses
      // the stream on its way out; the composer must resume it or every later
      // keystroke would sit in the kernel buffer.
      input.resume();
    },
  };
}
