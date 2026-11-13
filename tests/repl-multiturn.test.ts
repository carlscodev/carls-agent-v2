import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Prompt } from "../src/cli/Prompt.js";
import { Splash } from "../src/cli/Splash.js";
import { claimKeypress } from "../src/cli/Input.js";
import { runRepl } from "../src/cli/REPL.js";
import { Runtime } from "../src/core/Runtime.js";
import { loadConfig } from "../src/config/Config.js";
import { OpenAICompatProvider } from "../src/providers/OpenAICompatProvider.js";
import type { CompletionArgs } from "../src/types/llm.js";

/**
 * The REPL must survive a completed turn. The live failure this guards against
 * was an Anthropic stream whose `message_stop` sat in the SDK's buffer because
 * the server kept the socket open: the text was on screen, `runTurn` never
 * returned, and the next keystroke was either swallowed by the composer or
 * never reached the prompt.
 */

const originalStreams = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};
const originalEnv = {
  HOME: process.env.HOME,
  APPDATA: process.env.APPDATA,
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};
const originalPromptRead = Prompt.prototype.read;

type FakeInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (raw: boolean) => void;
};

interface CapturedOutput {
  isTTY: boolean;
  columns: number;
  rows: number;
  writes: string[];
  write: (chunk: string | Uint8Array) => boolean;
}

interface ReplHarness {
  input: FakeInput;
  output: CapturedOutput;
  text: () => string;
  waitPrompt: () => Promise<void>;
}

let dir: string;
let sockets: Set<Socket>;
let servers: Server[];
let promptReady = 0;
let promptsConsumed = 0;
let promptWaiters: (() => void)[] = [];
let harness: ReplHarness;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every synchronized update must open and close inside the same write. */
function assertSynchronizedWrites(writes: readonly string[]): void {
  for (const chunk of writes) {
    const begins = count(chunk, "\u001b[?2026h");
    if (begins === 0) continue;
    const ends = count(chunk, "\u001b[?2026l");
    expect(ends).toBeGreaterThanOrEqual(begins);
  }
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function anthropicFrames(requestNumber: number): string {
  const start = (usageIn: number): string =>
    sse("message_start", {
      type: "message_start",
      message: {
        id: `msg_${requestNumber}`,
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usageIn, output_tokens: 1 },
      },
    });
  if (requestNumber === 1) {
    return [
      start(12),
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool_1", name: "read_file", input: {} },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"note.txt"}' },
      }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 4 },
      }),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
  }
  const answer = requestNumber === 2 ? "answer one" : requestNumber === 3 ? "answer two" : "answer three";
  return [
    start(20),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: answer },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

function installHarness(): void {
  const input = new PassThrough() as FakeInput;
  (input as unknown as { isTTY: boolean }).isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw: boolean) => {
    input.isRaw = raw;
  };

  const output: CapturedOutput = {
    isTTY: true,
    columns: 100,
    rows: 30,
    writes: [],
    write(chunk: string | Uint8Array): boolean {
      output.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  };

  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stderr", { value: output, configurable: true });

  promptReady = 0;
  promptsConsumed = 0;
  promptWaiters = [];
  vi.spyOn(Prompt.prototype, "read").mockImplementation(function (this: Prompt, options) {
    const pending = originalPromptRead.call(this, options);
    queueMicrotask(() => {
      promptReady += 1;
      promptWaiters.shift()?.();
    });
    return pending;
  });

  harness = {
    input,
    output,
    text: () => output.writes.join(""),
    waitPrompt: async () => {
      while (promptReady <= promptsConsumed) {
        await new Promise<void>((resolve) => promptWaiters.push(resolve));
      }
      promptsConsumed += 1;
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "carls-repl-multiturn-"));
  process.env.HOME = join(dir, "home");
  process.env.APPDATA = join(dir, "appdata");
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-key";
  await writeFile(join(dir, "note.txt"), "tool observation\n", "utf8");
  await writeFile(
    join(dir, ".carlsrc.json"),
    JSON.stringify({ provider: "anthropic", model: "test-model", mode: "yolo", apiKey: "test-key" }),
    "utf8",
  );
  sockets = new Set<Socket>();
  servers = [];
  vi.spyOn(Splash, "show").mockResolvedValue(undefined);
  installHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "stdin", { value: originalStreams.stdin, configurable: true });
  Object.defineProperty(process, "stdout", { value: originalStreams.stdout, configurable: true });
  Object.defineProperty(process, "stderr", { value: originalStreams.stderr, configurable: true });
  restoreEnv("HOME", originalEnv.HOME);
  restoreEnv("APPDATA", originalEnv.APPDATA);
  restoreEnv("ANTHROPIC_API_KEY", originalEnv.anthropic);
  restoreEnv("OPENAI_API_KEY", originalEnv.openai);
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("single keypress route", () => {
  it("keeps one listener and hands it to the newest claimant", () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const first: string[] = [];
    const second: string[] = [];
    const releaseFirst = claimKeypress(input, (sequence) => first.push(sequence ?? ""));
    expect(input.listenerCount("keypress")).toBe(1);
    const releaseSecond = claimKeypress(input, (sequence) => second.push(sequence ?? ""));
    expect(input.listenerCount("keypress")).toBe(1);

    input.emit("keypress", "a", { name: "a" });
    expect(first).toEqual([]);
    expect(second).toEqual(["a"]);

    releaseSecond();
    input.emit("keypress", "b", { name: "b" });
    expect(second).toEqual(["a"]);

    releaseFirst();
    expect(input.listenerCount("keypress")).toBe(1);
  });
});

describe("REPL multi-turn", () => {
  it(
    "runs three turns against an Anthropic stream that never closes its socket",
    async () => {
      let requests = 0;
      const { port } = await startServer((req, res) => {
        req.resume();
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.on("error", () => undefined);
        requests += 1;
        res.write(anthropicFrames(requests));
        // Deliberately never call res.end(): message_stop must be enough.
      });

      const config = loadConfig(
        { provider: "anthropic", model: "test-model", baseUrl: `http://127.0.0.1:${port}`, yolo: true },
        dir,
      );
      const repl = runRepl({ config, overrides: {} });

      await withTimeout(harness.waitPrompt(), 3000, "prompt 1");
      expect(harness.input.isPaused()).toBe(false);
      harness.input.write("first\r");

      await withTimeout(harness.waitPrompt(), 3000, "prompt 2");
      expect(harness.input.isPaused()).toBe(false);
      expect(harness.text()).toContain("answer one");
      // Read-only calls in a step are grouped into one tree; the row still names
      // the tool and the file, which is what the operator needs to see.
      expect(harness.text()).toContain("read_file note.txt");
      harness.input.write("second\r");

      await withTimeout(harness.waitPrompt(), 3000, "prompt 3");
      expect(harness.input.isPaused()).toBe(false);
      expect(harness.text()).toContain("answer two");
      harness.input.write("third\r");

      await withTimeout(harness.waitPrompt(), 3000, "prompt 4");
      expect(harness.input.isPaused()).toBe(false);
      expect(harness.text()).toContain("answer three");
      harness.input.write("\u0004");

      await expect(withTimeout(repl, 5000, "repl exit")).resolves.toBe(0);
      expect(requests).toBe(4);
      assertSynchronizedWrites(harness.output.writes);
      const screen = harness.text();
      expect(screen).toContain("\u001b[?1049h");
      expect(screen).toContain("\u001b[?1049l");
      expect(screen.indexOf("\u001b[?1049l")).toBeLessThan(screen.indexOf("carls --resume"));
    },
    20_000,
  );

  it(
    "honors --no-alt-screen and keeps the legacy inline layout",
    async () => {
      const config = loadConfig(
        { provider: "anthropic", model: "test-model", baseUrl: "http://127.0.0.1:1", yolo: true },
        dir,
      );
      const repl = runRepl({ config, overrides: {}, noAltScreen: true });
      await withTimeout(harness.waitPrompt(), 3000, "prompt");
      expect(harness.text()).not.toContain("\u001b[?1049h");
      expect(harness.text()).not.toContain("\u001b[?1006h");
      harness.input.write("\u0004");
      await expect(withTimeout(repl, 5000, "repl exit")).resolves.toBe(0);
    },
    15_000,
  );

  it(
    "drains a message swallowed as approval during the previous turn",
    async () => {
      const config = loadConfig(
        { provider: "anthropic", model: "test-model", baseUrl: "http://127.0.0.1:1", yolo: true },
        dir,
      );
      let turns = 0;
      let turnWaiters: (() => void)[] = [];
      vi.spyOn(Runtime.prototype, "runTurn").mockImplementation(async (_goal, options = {}) => {
        turns += 1;
        for (const waiter of turnWaiters.splice(0)) waiter();
        options.onText?.(`simulated ${turns}`);
        await delay(250);
        return { steps: 1, finalText: `simulated ${turns}`, stoppedReason: "completed" };
      });

      const repl = runRepl({ config, overrides: {} });
      await withTimeout(harness.waitPrompt(), 3000, "prompt 1");
      harness.input.write("first\r");
      await withTimeout(
        new Promise<void>((resolve) => turnWaiters.push(resolve)),
        3000,
        "turn 1",
      );

      // "ok" classifies as approval, which the steering path deliberately does
      // not forward. The composer must queue it instead, then the turn-end
      // drain must start it without another keypress.
      harness.input.write("ok\r");
      await withTimeout(
        new Promise<void>((resolve) => turnWaiters.push(resolve)),
        3000,
        "auto-drained turn 2",
      );
      expect(turns).toBe(2);

      await withTimeout(harness.waitPrompt(), 3000, "prompt 2");
      harness.input.write("\u0004");
      await expect(withTimeout(repl, 5000, "repl exit")).resolves.toBe(0);
      expect(turns).toBe(2);
    },
    20_000,
  );
});

describe("SSE [DONE] with an open socket", () => {
  it("returns both consecutive turns instead of waiting for a TCP close", async () => {
    let requests = 0;
    const { port } = await startServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.on("error", () => undefined);
      requests += 1;
      res.write(`data: {"choices":[{"delta":{"content":"turn ${requests}"}}]}\n\n`);
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      // Keep the response open; [DONE] is the protocol's end marker.
    });

    const provider = new OpenAICompatProvider("test-key", `http://127.0.0.1:${port}/v1`);
    const baseArgs: CompletionArgs = {
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "one" }] }],
      tools: [],
      model: "test-model",
      maxTokens: 128,
    };

    const first = await withTimeout(provider.complete(baseArgs), 2000, "turn 1");
    expect(first.content).toEqual([{ type: "text", text: "turn 1" }]);
    const second = await withTimeout(
      provider.complete({
        ...baseArgs,
        messages: [...baseArgs.messages, { role: "user", content: [{ type: "text", text: "two" }] }],
      }),
      2000,
      "turn 2",
    );
    expect(second.content).toEqual([{ type: "text", text: "turn 2" }]);
    expect(requests).toBe(2);
  }, 10_000);
});
