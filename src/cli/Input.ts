import * as readline from "node:readline";

export interface KeyEvent {
  name?: string | undefined;
  ctrl?: boolean | undefined;
  sequence?: string | undefined;
}

export type KeypressHandler = (sequence: string | undefined, key: readline.Key) => void;

interface KeypressRoute {
  handler?: KeypressHandler;
  listener: (sequence: string | undefined, key: readline.Key) => void;
}

/**
 * One dispatcher per input stream.
 *
 * The prompt, the steering composer, the splash and the full-screen selectors
 * all need raw keypresses, but only one of them may act at a time. Attaching a
 * keypress listener per widget let a stopped or paused widget keep swallowing
 * keys (or left the stream paused after a ConPTY hand-off). This router keeps a
 * single listener attached and points it at the current owner; claiming twice
 * hands ownership to the newest widget, and releasing only clears it when that
 * widget is still the owner.
 */
const routes = new WeakMap<NodeJS.ReadStream, KeypressRoute>();

export function claimKeypress(input: NodeJS.ReadStream, handler: KeypressHandler): () => void {
  readline.emitKeypressEvents(input);
  let route = routes.get(input);
  if (route === undefined) {
    const created: KeypressRoute = {
      listener: (sequence, key) => {
        created.handler?.(sequence, key);
      },
    };
    routes.set(input, created);
    input.on("keypress", created.listener);
    route = created;
  }
  route.handler = handler;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (route.handler === handler) delete route.handler;
  };
}

/**
 * Reads one line at a time, creating a short-lived readline interface per
 * prompt. Between lines no readline listener is attached to stdin, which is
 * what lets raw-mode selectors own the terminal without the two fighting over
 * keystrokes.
 */
export class LineReader {
  private history: string[] = [];
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;

  constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr) {
    this.input = input;
    this.output = output;
  }

  /** Resolves the line, or null on EOF (Ctrl+D / closed input). */
  next(promptText: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const rl = readline.createInterface({
        input: this.input,
        output: this.output,
        terminal: true,
        historySize: 200,
      });
      // readline keeps history most-recent-first; the property is not in the
      // public typings, so we reach it through a narrow cast.
      const rlWithHistory = rl as unknown as { history: string[] };
      rlWithHistory.history = [...this.history].reverse();

      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        const captured = [...rlWithHistory.history].reverse();
        rl.removeAllListeners();
        rl.close();
        this.history = captured.slice(-200);
        resolve(value);
      };

      rl.on("line", (line) => finish(line));
      rl.on("close", () => finish(null));
      rl.setPrompt(promptText);
      rl.prompt();
    });
  }

  clearHistory(): void {
    this.history = [];
  }
}

/**
 * Takes exclusive control of stdin in raw mode and yields decoded key events.
 * Everything is restored in `finally`, so a crash inside the callback still
 * leaves the terminal usable.
 */
export class RawSession {
  static async with<T>(
    input: NodeJS.ReadStream,
    fn: (next: () => Promise<KeyEvent>) => Promise<T>,
  ): Promise<T> {
    const wasRaw = input.isRaw === true;
    if (input.setRawMode) input.setRawMode(true);
    input.resume();

    const queue: KeyEvent[] = [];
    let waiter: ((key: KeyEvent) => void) | undefined;
    const onKey = (_str: string | undefined, key: readline.Key): void => {
      const event: KeyEvent = { name: key.name, ctrl: key.ctrl, sequence: key.sequence };
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve(event);
      } else {
        queue.push(event);
      }
    };
    const releaseKeypress = claimKeypress(input, onKey);

    const next = (): Promise<KeyEvent> =>
      new Promise<KeyEvent>((resolve) => {
        const queued = queue.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        waiter = resolve;
      });

    try {
      return await fn(next);
    } finally {
      releaseKeypress();
      if (input.setRawMode) input.setRawMode(wasRaw);
      // Keep the stream live for the prompt/composer that takes over. Pausing
      // here on Windows is what left the next reader deaf to the keyboard.
      input.resume();
    }
  }
}


