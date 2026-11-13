import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Prompt } from "../src/cli/Prompt.js";
import { Splash } from "../src/cli/Splash.js";
import { runRepl } from "../src/cli/REPL.js";
import { AgentLoop } from "../src/core/AgentLoop.js";
import { ContextManager } from "../src/core/ContextManager.js";
import { CostTracker } from "../src/core/CostTracker.js";
import { Hooks } from "../src/core/Hooks.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { Logger } from "../src/utils/Logger.js";
import { loadConfig } from "../src/config/Config.js";
import type { CompletionArgs, LLMResponse, Provider } from "../src/types/llm.js";
import type { Tool, ToolResult } from "../src/types/tools.js";

/**
 * Live-TTY coverage for the Phase 8/9 cinematic surface: the fast-path that
 * trims MCP schemas, the Esc interrupt that stops a running turn, the think-tag
 * split that keeps a model's scratchpad out of the answer, and the stdio MCP
 * reconnect. Everything here drives the real REPL/loop over a fake TTY.
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

let dir: string;
let sockets: Set<Socket>;
let servers: Server[];
let promptReady = 0;
let promptsConsumed = 0;
let promptWaiters: (() => void)[] = [];
let harness: { input: FakeInput; output: CapturedOutput; text: () => string; waitPrompt: () => Promise<void> };
const logger = new Logger("error");

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

/** Polls the captured screen until `predicate` holds, or fails the test. */
async function waitForScreen(predicate: (text: string) => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate(harness.text())) return;
    await delay(20);
  }
  throw new Error(`${label} never appeared on screen`);
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

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicText(text: string, requestNumber = 1): string {
  return [
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
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

function thinkTagFrames(secret: string): string {
  const chunk = (delta: string): string => `data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}\n\n`;
  return [
    chunk(`<thinking>${secret}`),
    chunk("</thinking>"),
    chunk("listo"),
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ].join("");
}

async function waitForFile(path: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`file ${path} never appeared`);
}

function anthropicToolCall(id: string, name: string, inputJson: string): string {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: inputJson },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

function installHarness(): void {
  const input = new PassThrough() as FakeInput;
  input.isTTY = true;
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
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
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
  dir = await mkdtemp(join(tmpdir(), "carls-phase89-"));
  process.env.HOME = join(dir, "home");
  process.env.APPDATA = join(dir, "appdata");
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-key";
  await writeFile(
    join(dir, ".carlsrc.json"),
    JSON.stringify({ provider: "anthropic", model: "test-model", mode: "yolo" }),
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

/** A registered tool that only needs a name for schema-advertising assertions. */
function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    readOnly: true,
    schema: () => ({ name, description: `${name} tool`, input_schema: { type: "object" } }),
    parse: (input: unknown) => input,
    run: async (): Promise<ToolResult> => ({ ok: true, output: "ok" }),
  };
}

function buildLoop(provider: Provider, registry: ToolRegistry, config = loadConfig({ yolo: true, maxSteps: 2 }, dir)): AgentLoop {
  const session = new SessionStore(config.cwd, config.model, undefined, join(dir, "sessions"));
  return new AgentLoop({
    provider,
    registry,
    gate: new PermissionGate(config, logger, async () => "y"),
    contextManager: new ContextManager({ contextWindow: 200000, compactThreshold: 0.75, truncateLimit: 8000 }),
    session,
    costTracker: new CostTracker(config.model),
    hooks: new Hooks(config.hooks, logger, dir),
    config,
    logger,
    systemPrompt: "test",
    toolContext: { cwd: dir, config, session, logger },
  });
}

describe("phase 8/9 live TTY", () => {
  it("hides MCP tool schemas from a greeting but keeps them for a code task", async () => {
    const seen: string[][] = [];
    const provider: Provider = {
      name: "scripted",
      async complete(args: CompletionArgs): Promise<LLMResponse> {
        seen.push((args.tools ?? []).map((tool) => tool.name));
        return { content: [{ type: "text", text: "hola" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ToolRegistry();
    registry.register(fakeTool("read_file"));
    registry.register(fakeTool("mcp__github__create_issue"));
    const loop = buildLoop(provider, registry);

    await loop.run([{ role: "user", content: [{ type: "text", text: "hola" }] }], "hola", { silent: true });
    await loop.run(
      [{ role: "user", content: [{ type: "text", text: "arregla el bug de login en el archivo" }] }],
      "arregla el bug de login en el archivo",
      { silent: true },
    );

    // Fast path: no MCP schema in the request, so a greeting stays cheap.
    expect(seen[0]).toContain("read_file");
    expect(seen[0]).not.toContain("mcp__github__create_issue");
    // Direct work: the MCP tools are advertised again.
    expect(seen[1]).toContain("mcp__github__create_issue");
  });

  it(
    "stops a running turn with Esc and hands the prompt back",
    async () => {
      const markerFile = join(dir, "tool-started");
      let requests = 0;
      await startServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.on("error", () => undefined);
        requests += 1;
        if (requests === 1) {
          // The model asks for a long shell command, so the turn parks in a tool
          // execution instead of blocking inside a half-finished stream. The
          // touch lets the test know the child is really running before Esc.
          res.write(
            anthropicToolCall("toolu_1", "bash", JSON.stringify({ command: `touch ${markerFile} && sleep 30` })),
          );
        } else {
          res.write(anthropicText("terminado"));
        }
        res.end();
      });
      const port = (servers[0]?.address() as AddressInfo).port;
      const config = loadConfig(
        { provider: "anthropic", model: "test-model", baseUrl: `http://127.0.0.1:${port}`, yolo: true },
        dir,
      );
      const repl = runRepl({ config, overrides: {} });

      await withTimeout(harness.waitPrompt(), 3000, "prompt 1");
      harness.input.write("lanza un comando largo\r");
      await withTimeout(waitForFile(markerFile), 6000, "tool start");
      // Esc aborts the running turn; the shell child dies and the loop stops at
      // its next step boundary, which is where the operator banner is drawn.
      harness.input.write("\u001b");
      await waitForScreen((text) => text.includes("Turno interrumpido por el operador"), 8000, "interrupt banner");

      await withTimeout(harness.waitPrompt(), 5000, "prompt 2");
      expect(harness.input.isPaused()).toBe(false);
      harness.input.write("\u0004");
      await expect(withTimeout(repl, 8000, "repl exit")).resolves.toBe(0);
    },
    30_000,
  );

  it(
    "keeps a model's think-tag scratchpad out of the visible answer",
    async () => {
      let requests = 0;
      await startServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.on("error", () => undefined);
        requests += 1;
        res.write(requests === 1 ? thinkTagFrames("SECRETO") : anthropicText("listo"));
        res.end();
      });
      const port = (servers[0]?.address() as AddressInfo).port;
      const config = loadConfig(
        { provider: "openai", model: "test-model", baseUrl: `http://127.0.0.1:${port}/v1`, yolo: true },
        dir,
      );
      const repl = runRepl({ config, overrides: {} });

      await withTimeout(harness.waitPrompt(), 3000, "prompt 1");
      harness.input.write("hola\r");
      await withTimeout(harness.waitPrompt(), 3000, "prompt 2");

      const screen = harness.text();
      // The scratchpad is shown in its own reasoning block...
      expect(screen).toContain("SECRETO");
      expect(screen).toContain("pensando");
      // ...and the answer text never carries the tags.
      expect(screen).toContain("listo");
      expect(screen).not.toContain("<thinking>");
      harness.input.write("\u0004");
      await expect(withTimeout(repl, 5000, "repl exit")).resolves.toBe(0);
    },
    20_000,
  );
});

describe("mcp resilience", () => {
  it("reconnects a stdio server that dies mid-session", async () => {
    const { McpClient } = await import("../src/mcp/McpClient.js");
    // The child answers the first tools/call, then exits, so the next call has to
    // rebuild the transport instead of failing against a dead pipe.
    const script = [
      'let buffer = "";',
      'let calls = 0;',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk;",
      '  let index = buffer.indexOf("\\n");',
      "  while (index !== -1) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      '    index = buffer.indexOf("\\n");',
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.id === undefined) continue;",
      "    const result = message.method === 'initialize'",
      "      ? { protocolVersion: '2025-03-26', serverInfo: { name: 'flaky', version: '1.0.0' } }",
      "      : message.method === 'tools/list'",
      "      ? { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] }",
      "      : { content: [{ type: 'text', text: 'pong' }] };",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
      "    if (message.method === 'tools/call' && ++calls === 1) setTimeout(() => process.exit(0), 30);",
      "  }",
      "});",
    ].join("\n");

    const client = new McpClient("flaky", { command: process.execPath, args: ["-e", script] }, logger, dir);
    try {
      await client.initialize();
      const first = await client.callTool("ping", {});
      expect(first.ok).toBe(true);
      // Let the exit event land so the client marks itself dead.
      await delay(200);

      const second = await client.callTool("ping", {});
      expect(second.ok).toBe(true);
      expect(second.output).toBe("pong");
      expect(client.serverInfo()?.version).toBe("1.0.0");
    } finally {
      await client.close();
    }
  });
});
