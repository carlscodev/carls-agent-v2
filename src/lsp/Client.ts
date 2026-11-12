import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Minimal LSP client.
 *
 * A coding agent that has to run a full build to find out about a type error is
 * wasting a minute per mistake. A language server already knows: open the file,
 * wait for `textDocument/publishDiagnostics`, report it. This client speaks just
 * enough of the protocol for that — initialize, didOpen, diagnostics, shutdown —
 * and nothing else, so there is no dependency and no state to get wrong.
 */

export interface LspServerSpec {
  command: string;
  args?: string[];
  /** LSP languageId; defaults to the extension without the dot. */
  languageId?: string;
  /** Sent as initializationOptions. */
  initOptions?: unknown;
}

export interface DiagnosticPosition {
  line: number;
  character: number;
}

export interface LspDiagnostic {
  range: { start: DiagnosticPosition; end: DiagnosticPosition };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

/** `Content-Length: n\r\n\r\n<json>`, the only framing LSP has. */
export function frameMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Splits a buffer into complete messages, returning the unparsed remainder. */
export function unframe(buffer: Buffer): { messages: RpcMessage[]; rest: Buffer } {
  const messages: RpcMessage[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = rest.subarray(0, headerEnd).toString("ascii");
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (lengthMatch === null) {
      rest = rest.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (rest.length < bodyStart + length) break;
    const body = rest.subarray(bodyStart, bodyStart + length).toString("utf8");
    rest = rest.subarray(bodyStart + length);
    try {
      messages.push(JSON.parse(body) as RpcMessage);
    } catch {
      // A malformed frame from a broken server is not worth killing the run for.
    }
  }
  return { messages, rest };
}

const SEVERITIES = ["error", "warning", "info", "hint"];

/** Human label for the numeric severity LSP uses. */
export function severityLabel(severity: number | undefined): string {
  return SEVERITIES[(severity ?? 1) - 1] ?? "error";
}

export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly waiters = new Map<string, (diagnostics: LspDiagnostic[]) => void>();
  private closed = false;

  constructor(spec: LspServerSpec, cwd: string) {
    this.child = spawn(spec.command, spec.args ?? [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // Servers write progress to stderr; a full pipe would block them.
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", () => this.finishAll());
    this.child.on("exit", () => this.finishAll());
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, rest } = unframe(this.buffer);
    this.buffer = rest;
    for (const message of messages) {
      if (message.id !== undefined && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message);
        continue;
      }
      if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
        const uri = params?.uri;
        if (uri === undefined) continue;
        const list = params?.diagnostics ?? [];
        this.diagnostics.set(uri, list);
        this.waiters.get(uri)?.(list);
        this.waiters.delete(uri);
      }
    }
  }

  private request(message: RpcMessage, timeoutMs: number): Promise<RpcMessage> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", ...message, id };
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`language server did not answer ${message.method ?? "request"} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error !== undefined) {
          reject(new Error(reply.error.message ?? "language server error"));
          return;
        }
        resolve(reply);
      });
      if (this.closed || !this.child.stdin.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("language server is not running"));
        return;
      }
      this.child.stdin.write(frameMessage(payload));
    });
  }

  private notify(message: RpcMessage): void {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(frameMessage({ jsonrpc: "2.0", ...message }));
  }

  async initialize(spec: LspServerSpec, root: string, timeoutMs: number): Promise<void> {
    await this.request(
      {
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: pathToFileURL(root).toString(),
          capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
          ...(spec.initOptions !== undefined ? { initializationOptions: spec.initOptions } : {}),
        },
      },
      timeoutMs,
    );
    this.notify({ method: "initialized", params: {} });
  }

  /** Opens the document and resolves with the diagnostics pushed for it. */
  async diagnosticsFor(path: string, text: string, languageId: string, timeoutMs: number): Promise<LspDiagnostic[]> {
    const uri = pathToFileURL(path).toString();
    const already = this.diagnostics.get(uri);
    if (already !== undefined && already.length > 0) return already;

    const wait = new Promise<LspDiagnostic[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(uri);
        resolve(this.diagnostics.get(uri) ?? []);
      }, timeoutMs);
      this.waiters.set(uri, (list) => {
        clearTimeout(timer);
        resolve(list);
      });
    });
    this.notify({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId, version: 1, text } },
    });
    return wait;
  }

  private finishAll(): void {
    this.closed = true;
    for (const resolve of this.waiters.values()) resolve([]);
    this.waiters.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request({ method: "shutdown", params: null }, 2000);
      this.notify({ method: "exit", params: null });
    } catch {
      // A server that will not shut down politely gets killed below.
    }
    this.closed = true;
    this.child.kill("SIGTERM");
  }
}
