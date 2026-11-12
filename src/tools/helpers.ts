import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Data written to the child's stdin. */
  input?: string;
  maxBytes?: number;
}

/**
 * Runs a command without a shell, capturing bounded stdout/stderr. Used by the
 * tools that need structured output, where shell quoting would be a liability.
 */
export function run(command: string, args: string[], options: RunOptions): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    const startedAt = Date.now();
    const maxBytes = options.maxBytes ?? 512 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const outcome: ProcessOutcome = {
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
      };
      if (spawnError !== undefined) outcome.spawnError = spawnError;
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, options.timeoutMs));

    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => finish(null, null, error.message));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/**
 * Writes a file through a sibling temp file and a rename, so a crash mid-write
 * cannot leave a truncated file behind. Creates parent directories.
 */
export async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${Date.now()}.${process.pid}.carls.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

export interface HunkLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface PatchHunk {
  /** 1-based line number the hunk expects to start at; treated as a hint. */
  oldStart: number;
  lines: HunkLine[];
}

/**
 * Applies hunks in unified-diff order. The line number in the hunk header is a
 * hint: when it misses, the hunk is located by matching its context lines
 * within `fuzz` lines of the expected position.
 */
export function applyHunks(original: string[], hunks: PatchHunk[], fuzz = 3): string[] {
  const result = [...original];
  let offset = 0;

  for (const hunk of hunks) {
    const context = hunk.lines.filter((line) => line.type !== "add");
    const replacement = hunk.lines.filter((line) => line.type !== "remove");
    const expected = hunk.oldStart - 1 + offset;

    const at = locate(result, context.map((line) => line.text), expected, fuzz);
    if (at === -1) {
      throw new Error(`hunk starting at line ${hunk.oldStart} does not match the file`);
    }
    result.splice(at, context.length, ...replacement.map((line) => line.text));
    offset += replacement.length - context.length;
  }
  return result;
}

function locate(lines: string[], context: string[], expected: number, fuzz: number): number {
  if (context.length === 0) return Math.min(Math.max(0, expected), lines.length);
  const candidates = [expected];
  for (let distance = 1; distance <= fuzz; distance++) {
    candidates.push(expected - distance, expected + distance);
  }
  for (const start of candidates) {
    if (start < 0 || start + context.length > lines.length) continue;
    if (context.every((text, index) => lines[start + index] === text)) return start;
  }
  return -1;
}

/** Parses a unified diff into hunks, ignoring file headers. */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;

  for (const line of patch.split("\n")) {
    const header = line.match(/^@@\s*-(\d+)(?:,\d+)?\s*\+\d+(?:,\d+)?\s*@@/);
    if (header) {
      current = { oldStart: Number.parseInt(header[1] ?? "1", 10), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) current.lines.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ type: "remove", text: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ type: "context", text: line.slice(1) });
  }
  return hunks;
}
