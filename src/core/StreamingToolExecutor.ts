import type { ToolResult } from "../types/tools.js";

/**
 * Tool calls that are safe to start before the model finishes its turn.
 *
 * These five only observe the workspace: starting one early cannot change what
 * a sibling call sees, and their latency dominates exploration. Writes and
 * shell commands stay out on purpose — they must wait for a safe boundary and
 * for `PermissionGate`.
 */
export const PREFETCHABLE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "glob_files",
  "grep_search",
  "repo_map",
  "read_task_graph",
]);

/**
 * Tools that own the terminal while they run. They are read-only, but starting
 * one before the model's turn ends would put a question box on screen over a
 * stream that is still being written, so they are never prefetched.
 */
export const EXCLUSIVE_TOOLS: ReadonlySet<string> = new Set(["ask_user"]);

/** Matches `MAX_PARALLEL_TOOLS` in AgentLoop; kept local to avoid a cycle. */
export const STREAM_MAX_PARALLEL = 6;

export interface StreamingToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface PrefetchedToolResult {
  result: ToolResult;
  /** Wall-clock time the tool itself took, not the wait for the turn to end. */
  durationMs: number;
  /** True when the call was started during the stream. */
  prefetched: boolean;
}

export interface StreamingToolExecutorOptions {
  execute: (call: StreamingToolCall, signal: AbortSignal) => Promise<ToolResult>;
  /** The turn's signal, so Ctrl+C also cancels a prefetched read. */
  signal?: AbortSignal;
  maxParallel?: number;
  /** Override the allow-list, mainly for tests. */
  prefetchable?: (name: string) => boolean;
  onStart?: (call: StreamingToolCall) => void;
  onDone?: (call: StreamingToolCall, outcome: PrefetchedToolResult) => void;
}

/**
 * Runs read-only tools as soon as their arguments close in the stream.
 *
 * The ordering contract is what makes this safe to bolt onto an existing loop:
 * execution order is concurrent, but `take` returns results in the order the
 * caller asks for them, which is the order of the assistant's `tool_use` blocks.
 * A tool that finishes first is parked in `ready` until its turn comes.
 *
 * `abort` cancels the whole in-flight cohort. A critical write failing, or the
 * operator typing "stop", must not leave six reads racing a turn that is over.
 */
export class StreamingToolExecutor {
  private readonly options: StreamingToolExecutorOptions;
  private readonly maxParallel: number;
  private readonly prefetchable: (name: string) => boolean;
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Promise<PrefetchedToolResult>>();
  private readonly ready = new Map<string, PrefetchedToolResult>();
  private readonly waiters: (() => void)[] = [];
  /** The turn's signal, retained so `abort` can detach the listener it added. */
  private readonly externalSignal: AbortSignal | undefined;
  private readonly onExternalAbort = (): void => this.abort();
  private active = 0;
  private queued = 0;

  constructor(options: StreamingToolExecutorOptions) {
    this.options = options;
    this.maxParallel = Math.max(1, options.maxParallel ?? STREAM_MAX_PARALLEL);
    this.prefetchable = options.prefetchable ?? ((name) => PREFETCHABLE_TOOLS.has(name));

    const external = options.signal;
    this.externalSignal = external;
    if (external !== undefined) {
      if (external.aborted) this.controller.abort();
      else external.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  /** Calls currently executing. */
  get activeCount(): number {
    return this.active;
  }

  /** Calls accepted but waiting for a parallel slot. */
  get queuedCount(): number {
    return this.queued;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Offers a call to the prefetcher. Returns false when the tool is not
   * eligible or the call was already submitted.
   */
  submit(call: StreamingToolCall): boolean {
    if (EXCLUSIVE_TOOLS.has(call.name) || !this.prefetchable(call.name)) return false;
    if (this.pending.has(call.id) || this.ready.has(call.id)) return false;
    const promise = this.run(call);
    this.pending.set(call.id, promise);
    return true;
  }

  has(id: string): boolean {
    return this.pending.has(id) || this.ready.has(id);
  }

  /**
   * Returns the result for `call`, waiting for a prefetched run when there is
   * one and executing inline otherwise. Never rejects: a tool failure is data.
   */
  async take(call: StreamingToolCall): Promise<PrefetchedToolResult> {
    const ready = this.ready.get(call.id);
    if (ready !== undefined) {
      this.ready.delete(call.id);
      this.pending.delete(call.id);
      return ready;
    }
    const pending = this.pending.get(call.id);
    if (pending !== undefined) {
      const outcome = await pending.catch((error: unknown) => this.failure(error, call));
      this.pending.delete(call.id);
      this.ready.delete(call.id);
      return outcome;
    }
    return await this.runInline(call);
  }

  /** Cancels every in-flight and queued call, and unlinks the turn's abort. */
  abort(): void {
    // Detach first: the executor is scoped to one step, but it listens on the
    // turn's signal, which lives for the whole run. Leaving the listener attached
    // leaks one closure per step onto that signal, so a long turn accumulates
    // them and every later abort fires a cohort that is already over.
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
    if (this.controller.signal.aborted) {
      this.releaseAll();
      return;
    }
    this.controller.abort();
    this.releaseAll();
  }

  /** Waits for every submitted call to settle. Used at a step boundary. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }

  private async run(call: StreamingToolCall): Promise<PrefetchedToolResult> {
    this.queued++;
    const acquired = await this.acquire();
    this.queued--;
    if (!acquired) return this.abortedOutcome(call);

    const startedAt = Date.now();
    try {
      this.options.onStart?.(call);
      const result = await this.options.execute(call, this.controller.signal);
      const outcome: PrefetchedToolResult = {
        result,
        durationMs: Date.now() - startedAt,
        prefetched: true,
      };
      this.ready.set(call.id, outcome);
      this.options.onDone?.(call, outcome);
      return outcome;
    } catch (error) {
      const outcome = this.failure(error, call);
      this.ready.set(call.id, outcome);
      this.options.onDone?.(call, outcome);
      return outcome;
    } finally {
      this.release();
    }
  }

  private async runInline(call: StreamingToolCall): Promise<PrefetchedToolResult> {
    if (this.controller.signal.aborted) return this.abortedOutcome(call);
    const startedAt = Date.now();
    try {
      const result = await this.options.execute(call, this.controller.signal);
      return { result, durationMs: Date.now() - startedAt, prefetched: false };
    } catch (error) {
      return this.failure(error, call);
    }
  }

  private failure(error: unknown, call: StreamingToolCall): PrefetchedToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { ok: false, output: "", error: `Tool ${call.name} failed: ${message}` },
      durationMs: 0,
      prefetched: call.id.length > 0,
    };
  }

  private abortedOutcome(call: StreamingToolCall): PrefetchedToolResult {
    return {
      result: {
        ok: false,
        output: "",
        error: `Tool ${call.name} was aborted before it finished.`,
      },
      durationMs: 0,
      prefetched: true,
    };
  }

  private async acquire(): Promise<boolean> {
    while (this.active >= this.maxParallel) {
      if (this.controller.signal.aborted) return false;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    if (this.controller.signal.aborted) return false;
    // The check and the increment happen in one synchronous turn, so two calls
    // resumed together cannot both take the last slot.
    this.active++;
    return true;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  private releaseAll(): void {
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }
}
