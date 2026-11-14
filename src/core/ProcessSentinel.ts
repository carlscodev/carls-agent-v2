import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { shellForPlatform } from "../utils/platform.js";
import { detectOsProfile, killProcessTree, needsDetachedGroup } from "../os/OsRuntimeAdapter.js";

/**
 * Long-running process manager.
 *
 * A dev server never exits, so a normal `bash` call would hold the agent until a
 * timeout. The sentinel starts the command detached, reads its first lines,
 * detects the local port and returns control as soon as the server is reachable
 * (or after a short readiness window). The process keeps running in the
 * background and its last 200 lines stay available to `bg_logs`.
 */

export type ProcessStatus = "starting" | "ready" | "running" | "crashed" | "stopped";

export interface ManagedProcess {
  id: string;
  name: string;
  command: string;
  pid: number | undefined;
  status: ProcessStatus;
  port?: number | undefined;
  startedAt: string;
  /** Ring buffer of the last 200 stdout/stderr lines. */
  output: string[];
  errorCount: number;
  exitCode?: number | undefined;
}

export interface ProcessStartOptions {
  name?: string | undefined;
  cwd?: string | undefined;
  /** Readiness window before returning without a detected port. Default 3000ms. */
  waitForPortMs?: number | undefined;
  env?: Record<string, string> | undefined;
}

export interface ProcessStopResult {
  ok: boolean;
  id?: string;
  pid?: number | undefined;
  detail: string;
}

export interface ProcessSentinelOptions {
  cwd: string;
  /** Called whenever a process changes state, for a live HUD. */
  onChange?: (() => void) | undefined;
  /** Keep at most this many lines per process. Default 200. */
  ringSize?: number | undefined;
}

interface Entry {
  info: ManagedProcess;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
}

const PORT_PATTERNS: readonly RegExp[] = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)/i,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i,
  /\blistening(?:\s+on)?\b[^\d]*(\d{2,5})/i,
  /\bport\s+(\d{2,5})\b/i,
];

// No trailing `\b`: `Error:` ends in a non-word character, so a trailing word
// boundary would reject the most common stderr prefix.
const ERROR_PATTERN = /(?:\bError:|\bERR_[A-Z0-9_]+|\bSyntaxError|\bTypeError|\bTransform failed|\bEADDRINUSE|\bfailed to compile)/i;

function now(): string {
  return new Date().toISOString();
}

export class ProcessSentinel {
  private readonly cwd: string;
  private readonly onChange?: () => void;
  private readonly ringSize: number;
  private readonly entries = new Map<string, Entry>();
  private counter = 0;

  constructor(options: ProcessSentinelOptions) {
    this.cwd = options.cwd;
    this.ringSize = Math.max(20, options.ringSize ?? 200);
    if (options.onChange !== undefined) this.onChange = options.onChange;
  }

  /** Every managed process, newest last. */
  list(): ManagedProcess[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info, output: [...entry.info.output] }));
  }

  /** Number of processes not stopped/crashed. */
  get activeCount(): number {
    return [...this.entries.values()].filter(
      (entry) => entry.info.status === "starting" || entry.info.status === "ready" || entry.info.status === "running",
    ).length;
  }

  find(idOrName: string): ManagedProcess | undefined {
    const direct = this.entries.get(idOrName);
    if (direct !== undefined) return { ...direct.info, output: [...direct.info.output] };
    const byName = [...this.entries.values()].find((entry) => entry.info.name === idOrName);
    return byName === undefined ? undefined : { ...byName.info, output: [...byName.info.output] };
  }

  /**
   * Starts a command and resolves when a port is detected or the readiness
   * window closes. The child keeps running afterward.
   */
  async start(command: string, options: ProcessStartOptions = {}): Promise<ManagedProcess> {
    this.counter += 1;
    const id = `bg-${this.counter}`;
    const name = options.name ?? command.split(/\s+/)[0] ?? id;
    const shell = shellForPlatform();
    const commandText = `${command}${shell.commandSuffix ?? ""}`;
    const child = spawn(shell.file, [...shell.args, commandText], {
      cwd: options.cwd ?? this.cwd,
      env: { ...process.env, ...detectOsProfile().env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: needsDetachedGroup(),
      windowsHide: true,
    }) as unknown as ChildProcessWithoutNullStreams;

    const info: ManagedProcess = {
      id,
      name,
      command,
      pid: child.pid,
      status: "starting",
      startedAt: now(),
      output: [],
      errorCount: 0,
    };

    let settled = false;
    let resolveStart: ((value: ManagedProcess) => void) | undefined;
    const started = new Promise<ManagedProcess>((resolve) => {
      resolveStart = resolve;
    });
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      this.onChange?.();
      resolveStart?.({ ...info, output: [...info.output] });
    };

    const append = (chunk: string, isError: boolean): void => {
      // A port URL can be split across chunks; scan a small tail window.
      const scan = `${info.output.slice(-4).join("\n")}\n${chunk}`;
      for (const line of chunk.replace(/\r\n/g, "\n").split("\n")) {
        if (line.length === 0) continue;
        info.output.push(line);
        if (info.output.length > this.ringSize) info.output.shift();
        if (isError && ERROR_PATTERN.test(line)) info.errorCount += 1;
      }
      if (info.port === undefined) {
        for (const pattern of PORT_PATTERNS) {
          const match = pattern.exec(scan);
          if (match?.[1] !== undefined) {
            info.port = Number.parseInt(match[1], 10);
            info.status = "ready";
            settle();
            break;
          }
        }
      }
      this.onChange?.();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => append(chunk, false));
    child.stderr.on("data", (chunk: string) => append(chunk, true));

    let exitedResolve: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      exitedResolve = resolve;
    });
    child.once("exit", (code) => {
      info.exitCode = code ?? undefined;
      if (info.status !== "stopped") {
        info.status = code === 0 ? "stopped" : "crashed";
        if (code !== 0 && code !== null) info.errorCount += 1;
      }
      exitedResolve?.();
      settle();
    });
    child.once("error", (error) => {
      info.status = "crashed";
      info.errorCount += 1;
      info.output.push(`[spawn error] ${error.message}`);
      if (info.output.length > this.ringSize) info.output.shift();
      exitedResolve?.();
      settle();
    });

    const timer = setTimeout(() => {
      if (info.status === "starting") info.status = "running";
      settle();
    }, Math.max(250, options.waitForPortMs ?? 3000));
    timer.unref?.();

    this.entries.set(id, { info, child, exited });
    this.onChange?.();
    return await started;
  }

  /** Recent lines from a process, oldest first. */
  logs(idOrName: string, lines = 50): string[] {
    const process = this.find(idOrName);
    if (process === undefined) return [];
    return process.output.slice(-Math.max(1, Math.min(this.ringSize, lines)));
  }

  /** Kills the process tree and waits briefly for the exit event. */
  async stop(idOrName: string): Promise<ProcessStopResult> {
    const entry = this.entries.get(idOrName) ?? [...this.entries.values()].find((candidate) => candidate.info.name === idOrName);
    if (entry === undefined) return { ok: false, detail: `unknown process "${idOrName}"` };
    if (entry.info.status === "stopped" || entry.info.status === "crashed") {
      return { ok: true, id: entry.info.id, pid: entry.info.pid, detail: "already stopped" };
    }
    killProcessTree(entry.info.pid, "SIGKILL");
    entry.info.status = "stopped";
    this.onChange?.();
    await Promise.race([entry.exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    return { ok: true, id: entry.info.id, pid: entry.info.pid, detail: "stopped" };
  }

  /** Kills every managed process. Called on Runtime/session shutdown. */
  async disposeAll(): Promise<void> {
    const active = [...this.entries.values()].filter(
      (entry) => entry.info.status === "starting" || entry.info.status === "ready" || entry.info.status === "running",
    );
    for (const entry of active) {
      killProcessTree(entry.info.pid, "SIGKILL");
      entry.info.status = "stopped";
    }
    await Promise.all(
      active.map((entry) => Promise.race([entry.exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))])),
    );
    this.entries.clear();
    this.onChange?.();
  }
}

/** Exported for tests and `/ps` formatting. */
export function processLabel(process: ManagedProcess): string {
  const port = process.port !== undefined ? `:${process.port}` : "";
  const errors = process.errorCount > 0 ? ` !${process.errorCount}` : "";
  return `${process.name}${port} ${process.status}${errors}`;
}
