import * as readline from "node:readline";
import { PassThrough } from "node:stream";

export interface KeyEvent {
  name?: string | undefined;
  ctrl?: boolean | undefined;
  sequence?: string | undefined;
}

export type KeypressHandler = (sequence: string | undefined, key: readline.Key) => void;

/** One decoded SGR mouse report: button, column and row (all 1-based except button). */
export interface MouseEvent {
  /** Low bits are the button; 64/65 are wheel up/down, 32+ means motion. */
  button: number;
  column: number;
  row: number;
  /** `M` is a press (or a wheel notch), `m` a release. */
  final: "M" | "m";
}

export interface MouseSink {
  onWheel?: (direction: "up" | "down", event: MouseEvent) => void;
  onClick?: (event: MouseEvent) => void;
}

const SGR_MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** A complete report whose leading `\u001b[` was consumed by the decoder. */
const SGR_MOUSE_HEADLESS = /^<(\d+);(\d+);(\d+)([Mm])$/;
/** The longest tail we hold back while waiting for the rest of a report. */
const SGR_PREFIX_MAX = 24;

export function parseMouseEvent(button: string, column: string, row: string, final: string): MouseEvent {
  return {
    button: Number.parseInt(button, 10),
    column: Number.parseInt(column, 10),
    row: Number.parseInt(row, 10),
    final: final === "m" ? "m" : "M",
  };
}

/** True when `text` is a bare mouse report fragment that must never be typed. */
export function isMouseFragment(text: string): boolean {
  return SGR_MOUSE_HEADLESS.test(text);
}

/**
 * Splits a raw input chunk into the parts readline should decode and the mouse
 * reports it must never see.
 *
 * `readline.emitKeypressEvents` decodes `\u001b[<64;50;8M` as the escape alone
 * followed by the literal characters `6`, `4`, `;`, `5`, `0`, `;`, `8`, `M`, so a
 * wheel turn or a click used to be typed straight into the prompt. Extracting the
 * reports here keeps the bytes away from the decoder entirely.
 *
 * A report can be split across chunks; the trailing partial prefix is returned as
 * `carry` and must be prepended to the next chunk.
 */
export function splitMouseReports(chunk: string): { text: string; events: MouseEvent[]; carry: string } {
  const events: MouseEvent[] = [];
  let text = "";
  let index = 0;
  while (index < chunk.length) {
    const escape = chunk.indexOf("\u001b", index);
    if (escape === -1) {
      text += chunk.slice(index);
      break;
    }
    text += chunk.slice(index, escape);
    const rest = chunk.slice(escape);
    SGR_MOUSE.lastIndex = 0;
    const match = SGR_MOUSE.exec(rest);
    if (match !== null && match.index === 0) {
      events.push(parseMouseEvent(match[1] ?? "0", match[2] ?? "1", match[3] ?? "1", match[4] ?? "M"));
      index = escape + match[0].length;
      continue;
    }
    // An incomplete SGR report at the very end of the chunk: hold it back so the
    // next chunk can complete it instead of leaking half a sequence to readline.
    if (rest.length <= SGR_PREFIX_MAX && /^\u001b\[<\d*(;\d*){0,2}$/.test(rest)) {
      return { text, events, carry: rest };
    }
    // Not a mouse report: a normal escape sequence the decoder should handle.
    text += "\u001b";
    index = escape + 1;
  }
  return { text, events, carry: "" };
}

interface Route {
  /** The decoded stream handed to readline; a filtered view of the real stdin. */
  readonly filtered: PassThrough;
  /** Forwards raw bytes through the SGR filter and into `filtered`. */
  readonly pump: (chunk: Buffer | string) => void;
  /** Routes one decoded mouse report to the current sink. */
  readonly onMouse: (event: MouseEvent) => void;
  handler?: KeypressHandler;
  listener: (sequence: string | undefined, key: readline.Key) => void;
  sink: MouseSink;
  carry: string;
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
 *
 * It also owns the SGR mouse filter: `readline` is fed a `PassThrough` rather
 * than the terminal, so a wheel turn or a click becomes a routed event and never
 * a run of literal digits in the prompt.
 */
const routes = new WeakMap<NodeJS.ReadStream, Route>();

function ensureRoute(input: NodeJS.ReadStream): Route {
  let route = routes.get(input);
  if (route !== undefined) return route;

  const filtered = new PassThrough();
  const created: Route = {
    filtered,
    pump: (chunk) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const { text, events, carry } = splitMouseReports(`${created.carry}${raw}`);
      created.carry = carry;
      for (const event of events) created.onMouse(event);
      if (text.length > 0) filtered.write(text);
    },
    listener: (sequence, key) => {
      created.handler?.(sequence, key);
    },
    sink: {},
    onMouse: (event) => {
      const wheel = event.button & 0x40;
      if (wheel === 0x40) {
        created.sink.onWheel?.(event.button === 65 ? "down" : "up", event);
        return;
      }
      created.sink.onClick?.(event);
    },
    carry: "",
  };

  // readline decodes the filtered stream, never the terminal, so its data
  // listener sees only text and non-mouse escape sequences. The decoded key is
  // re-emitted on the real stream so the single `keypress` listener (and any
  // test that emits one directly) still observes it there.
  readline.emitKeypressEvents(filtered);
  filtered.on("keypress", (sequence: string | undefined, key: readline.Key) => {
    input.emit("keypress", sequence, key);
  });
  input.on("keypress", created.listener);
  input.on("data", created.pump);
  input.resume();
  routes.set(input, created);
  return created;
}

/** Routes decoded mouse reports; later calls replace the previous sink. */
export function claimMouse(input: NodeJS.ReadStream, sink: MouseSink): () => void {
  const route = ensureRoute(input);
  route.sink = sink;
  return () => {
    if (route.sink === sink) route.sink = {};
  };
}

export function claimKeypress(input: NodeJS.ReadStream, handler: KeypressHandler): () => void {
  const route = ensureRoute(input);
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
      // Read through the filtered view so a wheel turn or a click cannot be
      // inserted as literal digits into the line.
      const rl = readline.createInterface({
        input: ensureRoute(this.input).filtered as unknown as NodeJS.ReadableStream,
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


