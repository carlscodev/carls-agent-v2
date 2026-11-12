import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "../config/Config.js";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import type { Logger } from "../utils/Logger.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

const CALL_TIMEOUT_MS = 60000;

/**
 * Minimal Model Context Protocol client over stdio. Implements the handshake,
 * tool discovery and tool invocation. Messages are newline-delimited JSON-RPC
 * as required by the stdio transport.
 */
export class McpClient {
  readonly serverName: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly tools: McpToolDescriptor[] = [];
  private closed = false;

  constructor(serverName: string, config: McpServerConfig, logger: Logger, cwd: string) {
    this.serverName = serverName;
    this.logger = logger;
    this.child = spawn(config.command, config.args ?? [], {
      cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.logger.debug(`[mcp:${serverName}] ${chunk.trim()}`));
    this.child.on("error", (error) => this.failAll(new Error(`MCP server "${serverName}" error: ${error.message}`)));
    this.child.on("close", () => {
      this.closed = true;
      this.failAll(new Error(`MCP server "${serverName}" closed.`));
    });
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.logger.debug(`[mcp:${this.serverName}] non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    } else {
      entry.resolve(message.result);
    }
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.serverName}" is closed.`));
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) request.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${CALL_TIMEOUT_MS}ms.`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    const message = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "carls-code", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.send("tools/list")) as { tools?: McpToolDescriptor[] } | undefined;
    this.tools.length = 0;
    this.tools.push(...(result?.tools ?? []));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = (await this.send("tools/call", { name, arguments: args })) as
        | { content?: { type: string; text?: string }[]; isError?: boolean }
        | undefined;
      const text = (result?.content ?? [])
        .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
        .join("\n");
      const ok = result?.isError !== true;
      const out: ToolResult = { ok, output: text };
      if (!ok) out.error = text;
      return out;
    } catch (error) {
      return { ok: false, output: "", error: (error as Error).message };
    }
  }

  /** Wraps every discovered MCP tool as a harness `Tool` named mcp__server__tool. */
  asTools(): Tool[] {
    return this.tools.map((descriptor) => new McpTool(this, descriptor));
  }

  close(): void {
    this.closed = true;
    this.child.kill("SIGTERM");
  }
}

class McpTool implements Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  private readonly client: McpClient;
  private readonly remoteName: string;
  private readonly inputSchema: Record<string, unknown>;

  constructor(client: McpClient, descriptor: McpToolDescriptor) {
    this.client = client;
    this.remoteName = descriptor.name;
    this.name = `mcp__${client.serverName}__${descriptor.name}`;
    this.description = `[MCP ${client.serverName}] ${descriptor.description ?? descriptor.name}`;
    this.readOnly = descriptor.annotations?.readOnlyHint === true;
    this.inputSchema = descriptor.inputSchema ?? { type: "object", properties: {} };
  }

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: this.inputSchema };
  }

  parse(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== "object") {
      throw new Error(`${this.name} expects an object argument.`);
    }
    return input as Record<string, unknown>;
  }

  async run(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    return this.client.callTool(this.remoteName, input);
  }
}
