import * as readline from "node:readline";

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
}

/**
 * Reads lines from the terminal while a turn runs.
 *
 * It owns stdin in raw mode for the duration, so the caller must stop it before
 * opening the prompt again. Enter queues, Escape discards what is typed, Ctrl+C
 * aborts the turn (the signal is re-raised, because raw mode eats it).
 */
export function collectTypedLines(options: TypedLinesOptions): () => void {
  const { input, output } = options;
  const glyph = options.glyph ?? "⏳ ";
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  input.setRawMode?.(true);
  input.resume();
  let buffer = "";
  let stopped = false;

  const echo = options.echo !== false;
  const paint = (): void => {
    if (!echo) return;
    output.write(`\r\u001b[K${glyph}${buffer}`);
  };

  const onKey = (sequence: string | undefined, key: readline.Key): void => {
    if (stopped) return;
    const name = key.name ?? "";
    const seq = sequence ?? key.sequence ?? "";

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
          output.write("\r\u001b[K");
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
        buffer = "";
        output.write("\r\u001b[K");
        return;
      case "backspace":
        buffer = buffer.slice(0, -1);
        paint();
        return;
      default:
        break;
    }

    if (seq.length === 0 || seq.startsWith("\u001b")) return;
    const printable = seq.replace(/[\r\n]/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (printable.length > 0) {
      buffer += printable;
      paint();
    }
  };

  input.on("keypress", onKey);
  return () => {
    if (stopped) return;
    stopped = true;
    input.off("keypress", onKey);
    input.setRawMode?.(wasRaw);
    output.write("\r\u001b[K");
  };
}
