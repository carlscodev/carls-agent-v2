import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { LspClient, severityLabel, type LspDiagnostic, type LspServerSpec } from "./Client.js";

/**
 * Keeps language servers alive for the life of a session.
 *
 * The per-call client in `tools/Lsp.ts` is right for a one-off question: it
 * starts a server, asks, and closes. That is unusable for verification, where the
 * same file is checked after every node of a plan — a TypeScript server takes
 * seconds to index a project, and paying that per check turns a fast loop into a
 * slow one.
 *
 * This pool keys one live client per server key (the extension it serves), so the
 * first check pays the initialization and every later one is a round trip. A
 * server that has died is respawned on the next request rather than reused.
 */

export interface PooledDiagnostics {
  /** Workspace-relative path, for display. */
  path: string;
  diagnostics: LspDiagnostic[];
  /** Count of severity-1 diagnostics, which is what "introduced an error" means. */
  errors: number;
  warnings: number;
}

export interface LspVerification {
  /** True when every file checked came back with zero errors. */
  clean: boolean;
  checked: number;
  results: PooledDiagnostics[];
  /** Servers that could not be started, by key, with the reason. */
  unavailable: { key: string; reason: string }[];
}

export interface LspPoolOptions {
  /** Servers keyed by extension (".ts") or file name ("Makefile"). */
  servers: Record<string, LspServerSpec> | undefined;
  cwd: string;
  initTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 12_000;

interface PoolEntry {
  client: LspClient;
  spec: LspServerSpec;
  key: string;
}

export class LspSessionPool {
  private readonly servers: Record<string, LspServerSpec> | undefined;
  private readonly cwd: string;
  private readonly initTimeoutMs: number;
  private readonly diagnosticsTimeoutMs: number;
  /** Tracks which uris have been opened, so a re-check sends didChange. */
  private readonly opened = new Set<string>();
  private readonly entries = new Map<string, PoolEntry>();
  /** Reasons a key failed to start, so a bad command is reported once, not retried. */
  private readonly failures = new Map<string, string>();
  private closed = false;

  constructor(options: LspPoolOptions) {
    this.servers = options.servers;
    this.cwd = options.cwd;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.diagnosticsTimeoutMs = options.diagnosticsTimeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
  }

  get configured(): boolean {
    return this.servers !== undefined && Object.keys(this.servers).length > 0;
  }

  /** Resolves the server for a path: exact extension first, then exact file name. */
  specFor(path: string): { key: string; spec: LspServerSpec } | undefined {
    if (this.servers === undefined) return undefined;
    const extension = extname(path).toLowerCase();
    for (const [key, spec] of Object.entries(this.servers)) {
      if (key.toLowerCase() === extension) return { key, spec };
    }
    const base = path.split(/[\\/]/).pop() ?? "";
    for (const [key, spec] of Object.entries(this.servers)) {
      if (key.toLowerCase() === base.toLowerCase()) return { key, spec };
    }
    return undefined;
  }

  /**
   * Returns a live client for a key, starting one on first use.
   *
   * A client whose process has exited is discarded and replaced, which is the
   * reconnection path: the model's next check works even after a server crash.
   */
  private async clientFor(key: string, spec: LspServerSpec): Promise<LspClient> {
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.client.alive) return existing.client;
    if (existing !== undefined) {
      // The process died; drop the handle before replacing it.
      await existing.client.close().catch(() => undefined);
      this.entries.delete(key);
    }

    const failed = this.failures.get(key);
    if (failed !== undefined) throw new Error(failed);

    const client = new LspClient(spec, this.cwd);
    try {
      await client.initialize(spec, this.cwd, this.initTimeoutMs);
    } catch (error) {
      client.close().catch(() => undefined);
      const reason = `language server "${spec.command}" for ${key} failed to start: ${(error as Error).message}`;
      this.failures.set(key, reason);
      throw new Error(reason);
    }
    this.entries.set(key, { client, spec, key });
    return client;
  }

  /**
   * Checks one file and returns its diagnostics.
   *
   * The text is read fresh from disk and re-synced, so the result describes the
   * file as it is now. The first check of a uri opens the document; later checks
   * send a full-text change, which is what keeps the server's copy current.
   */
  async diagnosticsForFile(path: string): Promise<PooledDiagnostics | undefined> {
    if (this.closed) return undefined;
    const found = this.specFor(path);
    if (found === undefined) return undefined;

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }

    const client = await this.clientFor(found.key, found.spec);
    const languageId = found.spec.languageId ?? found.key.replace(/^\./, "");

    // The first check of a uri must open the document; every later one sends a
    // full-text change instead, because a second didOpen for the same uri is a
    // protocol error and a stale server copy would report stale diagnostics.
    let diagnostics: LspDiagnostic[];
    if (this.opened.has(path)) {
      const pending = client.waitForDiagnostics(path, this.diagnosticsTimeoutMs);
      client.syncDocument(path, text, languageId);
      diagnostics = await pending;
    } else {
      this.opened.add(path);
      diagnostics = await client.diagnosticsFor(path, text, languageId, this.diagnosticsTimeoutMs);
    }

    const errors = diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) === 1).length;
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 2).length;
    return { path, diagnostics, errors, warnings };
  }

  /**
   * Checks a set of files and answers the one question the DAG asks: did this
   * change introduce errors? A server that will not start is reported as
   * unavailable rather than counted as a failure, so a project without the
   * configured server is not blocked by verification.
   */
  async verify(paths: readonly string[]): Promise<LspVerification> {
    const results: PooledDiagnostics[] = [];
    const unavailable: { key: string; reason: string }[] = [];
    const seenKeys = new Set<string>();

    for (const path of paths) {
      const found = this.specFor(path);
      if (found === undefined) continue;
      try {
        const result = await this.diagnosticsForFile(path);
        if (result !== undefined) results.push(result);
      } catch (error) {
        if (!seenKeys.has(found.key)) {
          unavailable.push({ key: found.key, reason: (error as Error).message });
          seenKeys.add(found.key);
        }
      }
    }

    const errors = results.reduce((total, entry) => total + entry.errors, 0);
    return {
      clean: errors === 0,
      checked: results.length,
      results,
      unavailable,
    };
  }

  /** One line per file with errors, for a receipt or an observation. */
  static formatDiagnostics(verification: LspVerification): string {
    const lines: string[] = [];
    for (const entry of verification.results) {
      if (entry.errors === 0) continue;
      for (const diagnostic of entry.diagnostics) {
        if ((diagnostic.severity ?? 1) !== 1) continue;
        const line = diagnostic.range.start.line + 1;
        const column = diagnostic.range.start.character + 1;
        lines.push(`${entry.path}:${line}:${column} ${severityLabel(diagnostic.severity)}: ${diagnostic.message}`);
      }
    }
    for (const entry of verification.unavailable) {
      lines.push(`[unavailable] ${entry.key}: ${entry.reason}`);
    }
    return lines.join("\n");
  }

  /** How many servers are currently held open, for `/doctor` and tests. */
  activeCount(): number {
    return [...this.entries.values()].filter((entry) => entry.client.alive).length;
  }

  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.entries.values()].map((entry) => entry.client);
    this.entries.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
}
