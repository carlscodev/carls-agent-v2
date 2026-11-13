import type { McpServerConfig } from "../config/Config.js";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import type { Logger } from "../utils/Logger.js";
import {
  HttpTransport,
  SseTransport,
  StdioTransport,
  type McpTransport,
} from "./transports.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpServerInfo {
  name: string;
  version?: string;
  protocolVersion?: string;
}

const CALL_TIMEOUT_MS = 60000;
const INIT_TIMEOUT_MS = 20000;

/**
 * Model Context Protocol client.
 *
 * The protocol core lives here — handshake, request/response correlation by id,
 * tool discovery, invocation — and the wire is a `McpTransport`. That way a
 * local stdio server, a server that only speaks SSE and a Streamable HTTP
 * endpoint are the same code path with the same timeouts and error handling.
 */
export class McpClient {
  readonly serverName: string;
  readonly transportKind: "stdio" | "sse" | "http";
  private transport: McpTransport;
  private readonly logger: Logger;
  private readonly config: McpServerConfig;
  private readonly cwd: string;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly tools: McpToolDescriptor[] = [];
  private closed = false;
  private info: McpServerInfo | undefined;
  /** True after the transport died on its own; the next call reconnects. */
  private dead = false;
  private reconnecting: Promise<void> | undefined;
  /** Set by the runtime so a reconnect can re-register the new tool wrappers. */
  onReconnect: (() => void | Promise<void>) | undefined;

  constructor(serverName: string, config: McpServerConfig, logger: Logger, cwd: string) {
    this.serverName = serverName;
    this.logger = logger;
    this.config = config;
    this.cwd = cwd;
    this.transport = buildTransport(serverName, config, logger, cwd);
    this.transportKind = this.transport.kind;
    this.transport.onClose?.((error) => this.handleDeath(error));
  }

  /** Per-call timeout, overridable from the server config. */
  private callTimeoutMs(): number {
    return this.config.timeoutMs ?? CALL_TIMEOUT_MS;
  }

  private handleDeath(error?: Error): void {
    if (this.closed) return;
    this.dead = true;
    this.failAll(new Error(`MCP server "${this.serverName}" transport closed.`));
    this.logger.warn(
      `MCP "${this.serverName}" transport closed${error !== undefined ? `: ${error.message}` : ""}; reconnecting on next call.`,
    );
  }

  /**
   * Reconnects a transport that died on its own. Concurrent callers share one
   * attempt so a burst of tool calls after a crash does not spawn N children.
   */
  private async ensureAlive(): Promise<void> {
    if (!this.dead || this.closed) return;
    if (this.reconnecting === undefined) {
      this.reconnecting = this.doReconnect().finally(() => {
        this.reconnecting = undefined;
      });
    }
    await this.reconnecting;
  }

  private async doReconnect(): Promise<void> {
    this.logger.info(`MCP "${this.serverName}": reconnecting…`);
    await Promise.resolve(this.transport.close()).catch(() => undefined);
    this.transport = buildTransport(this.serverName, this.config, this.logger, this.cwd);
    this.transport.onClose?.((error) => this.handleDeath(error));
    await this.transport.start((message) => this.handleMessage(message));
    const result = (await this.rawRequest(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        clientInfo: { name: "carls-code", version: "0.1.0" },
      },
      INIT_TIMEOUT_MS,
    )) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string } | undefined;
    const info: McpServerInfo = { name: this.serverName };
    if (result?.serverInfo?.version !== undefined) info.version = result.serverInfo.version;
    if (result?.protocolVersion !== undefined) info.protocolVersion = result.protocolVersion;
    this.info = info;
    this.notify("notifications/initialized");
    // Clear `dead` before listing tools: `listTools` goes through `request`,
    // which would otherwise await this very reconnect and deadlock.
    this.dead = false;
    await this.listTools();
    await this.onReconnect?.();
    this.logger.info(`MCP "${this.serverName}": reconnected (${this.tools.length} tool(s)).`);
  }

  /** Server name and version as reported during the handshake, for /mcp. */
  serverInfo(): McpServerInfo | undefined {
    return this.info;
  }

  /** Round-trips a `ping` and returns the latency in ms, for `/mcp status|test`. */
  async ping(timeoutMs = 5000): Promise<number> {
    const started = Date.now();
    await this.request("ping", {}, timeoutMs);
    return Date.now() - started;
  }

  /** The tools discovered at the last handshake, for `/mcp test`. */
  toolNames(): string[] {
    return this.tools.map((descriptor) => descriptor.name);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage(message: unknown): void {
    if (message === null || typeof message !== "object") return;
    const response = message as JsonRpcResponse;
    if (typeof response.id !== "number") return;
    const entry = this.pending.get(response.id);
    if (entry === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error !== undefined) {
      entry.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    } else {
      entry.resolve(response.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = this.callTimeoutMs()): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.serverName}" is closed.`));
    if (this.dead) {
      // Reconnect once, then run the call against the fresh transport. A second
      // death between the check and the send still surfaces as a normal error.
      return this.ensureAlive().then(() => this.rawRequest(method, params, timeoutMs));
    }
    return this.rawRequest(method, params, timeoutMs);
  }

  private rawRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.transport.send(message, timeoutMs).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    // A notification has no response to correlate, so a transport error here is
    // only worth a debug line; the next request will surface a real failure.
    void this.transport.send(message, CALL_TIMEOUT_MS).catch((error: unknown) => {
      this.logger.debug(`[mcp:${this.serverName}] notify ${method} failed: ${(error as Error).message}`);
    });
  }

  async initialize(): Promise<void> {
    await this.transport.start((message) => this.handleMessage(message));
    const result = (await this.rawRequest(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        clientInfo: { name: "carls-code", version: "0.1.0" },
      },
      INIT_TIMEOUT_MS,
    )) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string } | undefined;

    const info: McpServerInfo = { name: this.serverName };
    if (result?.serverInfo?.version !== undefined) info.version = result.serverInfo.version;
    if (result?.protocolVersion !== undefined) info.protocolVersion = result.protocolVersion;
    this.info = info;
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {}) as { tools?: McpToolDescriptor[] } | undefined) ?? {};
    this.tools.length = 0;
    this.tools.push(...(result.tools ?? []));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = (await this.request("tools/call", { name, arguments: args })) as
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`MCP server "${this.serverName}" closed.`));
    await this.transport.close();
  }
}

/**
 * Picks the wire the config asks for. A `url` with no transport means Streamable
 * HTTP, because that is the current spec; `transport: "sse"` is the older
 * two-endpoint variant.
 */
export function buildTransport(
  serverName: string,
  config: McpServerConfig,
  logger: Logger,
  cwd: string,
): McpTransport {
  if (config.url !== undefined && config.url.length > 0) {
    const headers = remoteHeaders(config.env);
    if (config.transport === "sse") {
      return new SseTransport({ url: config.url, headers, logger, serverName });
    }
    return new HttpTransport({ url: config.url, headers, logger, serverName });
  }
  if (config.command !== undefined && config.command.length > 0) {
    return new StdioTransport({
      command: config.command,
      args: config.args ?? [],
      cwd,
      env: config.env ?? {},
      logger,
      serverName,
    });
  }
  throw new Error(`MCP server "${serverName}" needs either "command" (stdio) or "url" (sse/http).`);
}

function remoteHeaders(env: Record<string, string> | undefined): Record<string, string> {
  const token = env?.["Authorization"] ?? env?.["MCP_TOKEN"] ?? process.env.CARLS_MCP_TOKEN;
  return token !== undefined && token.length > 0 ? { authorization: token } : {};
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
