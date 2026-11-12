import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "../utils/Logger.js";

/**
 * MCP transports. The client above them only cares about "deliver me JSON-RPC
 * messages" and "send this message", which is what lets one implementation
 * speak stdio, SSE and Streamable HTTP.
 *
 * - stdio: newline-delimited JSON on a child process (the local server case).
 * - sse:   the 2024-11-05 HTTP transport. A GET stream announces a POST
 *          endpoint, answers arrive on the same stream.
 * - http:  the 2025-03-26 Streamable HTTP transport. Each POST carries a
 *          request and its answer comes back in the response body, either as
 *          JSON or as a single-use SSE stream.
 */

export type MessageSink = (message: unknown) => void;

export interface McpTransport {
  readonly kind: "stdio" | "sse" | "http";
  start(sink: MessageSink): Promise<void>;
  send(message: unknown, timeoutMs: number): Promise<void>;
  close(): void;
}

/** Splits an SSE byte stream into `{ event, data }` frames. */
export function createSseParser(onEvent: (event: { event: string; data: string }) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data: string[] = [];
      let event = "message";
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) onEvent({ event, data: data.join("\n") });
      boundary = buffer.indexOf("\n\n");
    }
  };
}

/** Delivers one JSON-RPC payload, unwrapping batch arrays. */
function deliver(sink: MessageSink, payload: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) sink(entry);
    return;
  }
  sink(parsed);
}

function parseJsonRpc(payload: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  sink: MessageSink,
  onFrame?: (event: { event: string; data: string }) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser((event) => {
    onFrame?.(event);
    if (event.event === "message") deliver(sink, event.data);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parse(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
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
        reject(error);
      },
    );
  });
}

// ------------------------------------------------------------------ stdio

export interface StdioOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logger: Logger;
  serverName: string;
}

export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;
  private readonly serverName: string;
  private buffer = "";
  private sink: MessageSink = () => {};
  private closed = false;

  constructor(options: StdioOptions) {
    this.logger = options.logger;
    this.serverName = options.serverName;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) =>
      this.logger.debug(`[mcp:${this.serverName}] ${chunk.trim()}`),
    );
  }

  async start(sink: MessageSink): Promise<void> {
    this.sink = sink;
    // The child is spawned in the constructor, so "spawn" may already have
    // fired; waiting for it again would hang the handshake.
    if (this.child.pid !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      this.child.once("spawn", () => resolve());
      this.child.once("error", (error) => reject(new Error(`cannot start "${this.serverName}": ${error.message}`)));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        for (const message of parseJsonRpc(line)) this.sink(message);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  send(message: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.serverName}" is closed.`));
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
    this.child.kill("SIGTERM");
  }
}

// -------------------------------------------------------------------- sse

/** Headers a remote MCP server may need; kept out of the config file. */
export function remoteHeaders(env: Record<string, string> | undefined): Record<string, string> {
  const token = env?.["Authorization"] ?? env?.["MCP_TOKEN"] ?? process.env.CARLS_MCP_TOKEN;
  return token !== undefined && token.length > 0 ? { authorization: token } : {};
}

export class SseTransport implements McpTransport {
  readonly kind = "sse" as const;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly logger: Logger;
  private readonly serverName: string;
  private controller: AbortController | undefined;
  private endpoint: string | undefined;
  private sink: MessageSink = () => {};
  private closed = false;

  constructor(options: { url: string; headers: Record<string, string>; logger: Logger; serverName: string }) {
    this.url = options.url;
    this.headers = options.headers;
    this.logger = options.logger;
    this.serverName = options.serverName;
  }

  async start(sink: MessageSink): Promise<void> {
    this.sink = sink;
    const controller = new AbortController();
    this.controller = controller;

    let announce: (endpoint: string) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const ready = new Promise<string>((resolve, reject) => {
      announce = resolve;
      fail = reject;
    });

    const response = await fetch(this.url, {
      headers: { accept: "text/event-stream", ...this.headers },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`MCP SSE handshake failed: HTTP ${response.status} from ${this.url}`);
    }

    void readSse(response.body, this.sink, (event) => {
      if (event.event === "endpoint") {
        announce(new URL(event.data.trim(), this.url).toString());
      }
    }).catch((error: unknown) => {
      if (!this.closed) fail(new Error(`MCP SSE stream from "${this.serverName}" ended: ${(error as Error).message}`));
    });

    this.endpoint = await withTimeout(ready, 15000, `MCP SSE endpoint for "${this.serverName}"`);
    this.logger.debug(`[mcp:${this.serverName}] SSE endpoint ${this.endpoint}`);
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) throw new Error(`MCP server "${this.serverName}" is closed.`);
    if (this.endpoint === undefined) throw new Error(`MCP SSE transport for "${this.serverName}" is not ready.`);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(message),
    });
    // The answer travels on the GET stream, so the POST only needs accepting.
    await response.text();
    if (!response.ok) throw new Error(`MCP SSE POST failed: HTTP ${response.status}`);
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }
}

// ------------------------------------------------------------------- http

export class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly logger: Logger;
  private readonly serverName: string;
  private sessionId: string | undefined;
  private sink: MessageSink = () => {};
  private closed = false;

  constructor(options: { url: string; headers: Record<string, string>; logger: Logger; serverName: string }) {
    this.url = options.url;
    this.headers = options.headers;
    this.logger = options.logger;
    this.serverName = options.serverName;
  }

  async start(sink: MessageSink): Promise<void> {
    this.sink = sink;
  }

  async send(message: unknown, timeoutMs: number): Promise<void> {
    if (this.closed) throw new Error(`MCP server "${this.serverName}" is closed.`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId !== undefined ? { "mcp-session-id": this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const session = response.headers.get("mcp-session-id");
      if (session !== null) this.sessionId = session;

      // 202 and 204 mean "accepted", which is all a notification needs.
      if (response.status === 202 || response.status === 204) {
        await response.text();
        return;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`MCP HTTP ${response.status} from "${this.serverName}": ${body.slice(0, 300)}`);
      }

      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && response.body !== null) {
        const body = response.body;
        await withTimeout(
          readSse(body, this.sink).then(() => undefined),
          timeoutMs,
          `MCP HTTP stream from "${this.serverName}"`,
        );
        return;
      }
      const text = await response.text();
      if (text.trim().length > 0) deliver(this.sink, text);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.closed = true;
  }
}

export { deliver as deliverPayload };
