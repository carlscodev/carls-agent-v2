import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FrameCoalescer, FrameRenderer } from "../src/cli/FrameRenderer.js";
import { StreamingToolExecutor } from "../src/core/StreamingToolExecutor.js";
import { FileStateCache, contentHash, fileStateCache, resetFileStateCache } from "../src/core/FileStateCache.js";
import { RepoMap } from "../src/core/RepoMap.js";
import { EventBus } from "../src/core/EventBus.js";
import { AgentLoop } from "../src/core/AgentLoop.js";
import { CostTracker } from "../src/core/CostTracker.js";
import { Hooks } from "../src/core/Hooks.js";
import { ContextManager } from "../src/core/ContextManager.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { loadConfig } from "../src/config/Config.js";
import { Logger } from "../src/utils/Logger.js";
import type { Message } from "../src/types/llm.js";
import type { Tool } from "../src/types/tools.js";

/** A minimal TTY-shaped sink, so the renderer can be tested without a pty. */
class FakeOut {
  isTTY: boolean;
  columns = 80;
  rows = 24;
  writes: string[] = [];

  constructor(isTTY = true) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  text(): string {
    return this.writes.join("");
  }
}

function output(out: FakeOut): NodeJS.WriteStream {
  return out as unknown as NodeJS.WriteStream;
}

describe("FrameRenderer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps the first frame in Mode 2026 and writes every row", () => {
    const out = new FakeOut();
    const renderer = new FrameRenderer(output(out), { coalesce: false });

    renderer.render(["alpha", "beta"]);

    expect(out.text()).toContain("\u001b[?2026h");
    expect(out.text()).toContain("\u001b[?2026l");
    expect(out.text()).toContain("alpha");
    expect(out.text()).toContain("beta");
    expect(renderer.frameCount).toBe(1);
  });

  it("rewrites only the rows that changed", () => {
    const out = new FakeOut();
    const renderer = new FrameRenderer(output(out), { coalesce: false });
    renderer.render(["alpha", "beta"]);
    out.writes.length = 0;

    renderer.render(["alpha", "BETA"]);

    const text = out.text();
    // Row 2 changed; row 1 must not be repainted.
    expect(text).toContain("\u001b[2;1H");
    expect(text).toContain("BETA");
    expect(text).not.toContain("\u001b[1;1H");
    expect(renderer.frameCount).toBe(2);
  });

  it("does not write at all when the frame is identical", () => {
    const out = new FakeOut();
    const renderer = new FrameRenderer(output(out), { coalesce: false });
    renderer.render(["same"]);
    out.writes.length = 0;

    renderer.render(["same"]);

    expect(out.writes).toHaveLength(0);
    expect(renderer.frameCount).toBe(1);
  });

  it("coalesces renders inside one 16 ms frame", () => {
    vi.useFakeTimers();
    const out = new FakeOut();
    const renderer = new FrameRenderer(output(out), { coalesce: true, intervalMs: 16 });

    renderer.render(["one"]);
    renderer.render(["two"]);
    renderer.render(["three"]);
    expect(out.writes).toHaveLength(0);

    vi.advanceTimersByTime(16);

    expect(out.writes).toHaveLength(1);
    expect(out.text()).toContain("three");
    expect(out.text()).not.toContain("one");
    renderer.dispose();
  });

  it("writes plain lines and no control sequences for a pipe", () => {
    const out = new FakeOut(false);
    const renderer = new FrameRenderer(output(out), { coalesce: false });

    renderer.render(["x", "y"]);

    expect(out.text()).toBe("x\ny\n");
    expect(out.text()).not.toContain("2026");
  });

  it("erases the rows of the last frame", () => {
    const out = new FakeOut();
    const renderer = new FrameRenderer(output(out), { coalesce: false });
    renderer.render(["a", "b"]);
    out.writes.length = 0;

    renderer.clear();

    expect(out.text()).toContain("\u001b[1;1H\u001b[2K");
    expect(out.text()).toContain("\u001b[2;1H\u001b[2K");
    expect(renderer.lastFrame).toHaveLength(0);
  });
});

describe("FrameCoalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches every chunk pushed inside the frame window", () => {
    vi.useFakeTimers();
    const batches: string[] = [];
    const coalescer = new FrameCoalescer((text) => batches.push(text), 16);

    coalescer.push("a");
    coalescer.push("b");
    coalescer.push("c");
    expect(batches).toHaveLength(0);
    expect(coalescer.pending).toBe(3);

    vi.advanceTimersByTime(16);

    expect(batches).toEqual(["abc"]);
    expect(coalescer.pending).toBe(0);
    coalescer.dispose();
  });

  it("flushes immediately at a tool or turn boundary", () => {
    const batches: string[] = [];
    const coalescer = new FrameCoalescer((text) => batches.push(text), 16);
    coalescer.push("partial");
    coalescer.flush();
    expect(batches).toEqual(["partial"]);
    coalescer.dispose();
  });
});

describe("StreamingToolExecutor", () => {
  const call = (id: string, name = "read_file") => ({ id, name, input: { id } });

  it("runs prefetched reads in parallel but never above the cap", async () => {
    let active = 0;
    let peak = 0;
    const executor = new StreamingToolExecutor({
      maxParallel: 2,
      execute: async (toolCall) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { ok: true, output: toolCall.id };
      },
    });

    for (const id of ["a", "b", "c"]) executor.submit(call(id));
    await executor.settle();

    expect(peak).toBe(2);
    const order: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const outcome = await executor.take(call(id));
      order.push(outcome.result.output);
    }
    expect(order).toEqual(["a", "b", "c"]);
    expect(executor.activeCount).toBe(0);
  });

  it("returns results in the caller's order even when they finish backwards", async () => {
    const executor = new StreamingToolExecutor({
      maxParallel: 3,
      execute: async (toolCall) => {
        const delay = toolCall.id === "a" ? 30 : toolCall.id === "b" ? 15 : 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { ok: true, output: toolCall.id };
      },
    });

    for (const id of ["a", "b", "c"]) executor.submit(call(id));
    await executor.settle();

    const order: string[] = [];
    for (const id of ["a", "b", "c"]) order.push((await executor.take(call(id))).result.output);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("aborts siblings in flight and in the queue", async () => {
    const started: string[] = [];
    const executor = new StreamingToolExecutor({
      maxParallel: 1,
      execute: async (toolCall, signal) => {
        started.push(toolCall.id);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { ok: true, output: toolCall.id };
      },
    });

    executor.submit(call("a"));
    executor.submit(call("b"));
    executor.submit(call("c"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    executor.abort();

    const outcomes = await Promise.all([executor.take(call("a")), executor.take(call("b")), executor.take(call("c"))]);
    for (const outcome of outcomes) {
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error).toContain("aborted");
    }
    // Only the first call ever reached the executor; the queued ones were
    // released as aborted without starting.
    expect(started).toEqual(["a"]);
    expect(executor.activeCount).toBe(0);
  });

  it("refuses to prefetch a write or shell tool", async () => {
    const executor = new StreamingToolExecutor({ execute: async () => ({ ok: true, output: "" }) });
    expect(executor.submit(call("w", "write_file"))).toBe(false);
    expect(executor.submit(call("s", "bash"))).toBe(false);
    expect(executor.submit(call("r", "read_file"))).toBe(true);
    expect(executor.submit(call("r", "read_file"))).toBe(false);
  });

  it("detaches its turn-signal listener on abort, so a long turn cannot leak one per step", async () => {
    // The executor is rebuilt every step, but the turn signal lives for the whole
    // run. Without detaching, each step adds a listener that never leaves, so a
    // 30-step turn piles up 30 closures on one signal.
    const turn = new AbortController();
    const baseline = getEventListeners(turn.signal, "abort").length;
    for (let step = 0; step < 30; step++) {
      const executor = new StreamingToolExecutor({
        execute: async () => ({ ok: true, output: "" }),
        signal: turn.signal,
      });
      executor.abort();
    }
    expect(getEventListeners(turn.signal, "abort").length).toBe(baseline);
  });

  it("still aborts in-flight work when the turn signal fires", async () => {
    const turn = new AbortController();
    const started: string[] = [];
    const executor = new StreamingToolExecutor({
      signal: turn.signal,
      execute: async (toolCall, signal) => {
        started.push(toolCall.id);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { ok: true, output: toolCall.id };
      },
    });

    executor.submit(call("a"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    turn.abort();

    const outcome = await executor.take(call("a"));
    expect(started).toEqual(["a"]);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toContain("aborted");
  });
});

describe("FileStateCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carls-phase4-"));
    resetFileStateCache();
  });

  afterEach(async () => {
    resetFileStateCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("reuses parsed symbols while mtime and size are unchanged", async () => {
    await writeFile(join(dir, "alpha.ts"), "export function alpha() { return 1; }\n", "utf8");
    const cache = new FileStateCache();
    const map = new RepoMap(dir, { cache });

    const first = map.build();
    expect(first.parsedFiles).toBe(1);
    expect(first.cachedFiles).toBe(0);
    expect(map.find("alpha")).toHaveLength(1);

    const second = map.build();
    expect(second.parsedFiles).toBe(0);
    expect(second.cachedFiles).toBe(1);
    expect(map.find("alpha")).toHaveLength(1);
    expect(cache.stats().hits).toBeGreaterThan(0);
  });

  it("reparses after an explicit invalidation", async () => {
    const file = join(dir, "alpha.ts");
    await writeFile(file, "export function alpha() { return 1; }\n", "utf8");
    const cache = new FileStateCache();
    const map = new RepoMap(dir, { cache });
    map.build();

    expect(cache.invalidate(file)).toBe(true);
    const rebuilt = map.build();

    expect(rebuilt.parsedFiles).toBe(1);
    expect(rebuilt.cachedFiles).toBe(0);
  });

  it("detects a same-size rewrite through mtime", async () => {
    const file = join(dir, "alpha.ts");
    await writeFile(file, "export function alpha() { return 1; }\n", "utf8");
    const cache = new FileStateCache();
    const map = new RepoMap(dir, { cache });
    map.build();

    // Same length, different symbol: only the mtime can reveal the edit. Set it
    // explicitly because a fast rewrite can land in the same timestamp tick.
    await writeFile(file, "export function gamma() { return 1; }\n", "utf8");
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    const rebuilt = map.build();

    expect(rebuilt.parsedFiles).toBe(1);
    expect(map.find("gamma")).toHaveLength(1);
    expect(map.find("alpha")).toHaveLength(0);
  });

  it("drops a whole subtree for a multi-file write", async () => {
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    const cache = new FileStateCache();
    cache.put(join(dir, "a.ts"), {
      file: "a.ts",
      mtimeMs: 1,
      size: 10,
      contentHash: contentHash("export const a = 1;\n"),
      symbols: [],
      imports: [],
      lines: 1,
    });
    expect(cache.size).toBe(1);
    expect(cache.invalidateUnder(dir)).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("evicts the least-recently used entry past the cap", () => {
    const cache = new FileStateCache({ maxEntries: 16 });
    for (let index = 0; index < 20; index++) {
      cache.put(join(dir, `f${index}.ts`), {
        file: `f${index}.ts`,
        mtimeMs: index,
        size: index,
        contentHash: contentHash(String(index)),
        symbols: [],
        imports: [],
        lines: 1,
      });
    }
    expect(cache.size).toBe(16);
    expect(cache.stats().evictions).toBe(4);
  });
});

describe("EventBus", () => {
  it("subscribes, unsubscribes and fires once", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on("stream.delta", (event) => seen.push(event.text));
    bus.emit("stream.delta", { kind: "text", text: "a", at: 0 });
    off();
    bus.emit("stream.delta", { kind: "text", text: "b", at: 0 });
    expect(seen).toEqual(["a"]);

    bus.once("tool.start", (event) => seen.push(event.name));
    bus.emit("tool.start", { id: "1", name: "read_file", input: {}, at: 0 });
    bus.emit("tool.start", { id: "2", name: "grep_search", input: {}, at: 0 });
    expect(seen).toEqual(["a", "read_file"]);
    expect(bus.listenerCount()).toBe(0);
  });

  it("isolates a throwing subscriber from the rest", () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ onError: (error) => errors.push(error) });
    const seen: string[] = [];
    bus.on("tool.done", () => {
      throw new Error("panel crashed");
    });
    bus.on("tool.done", (event) => seen.push(event.name));

    bus.emit("tool.done", { id: "1", name: "read_file", ok: true, durationMs: 1, at: 0 });

    expect(seen).toEqual(["read_file"]);
    expect(errors).toHaveLength(1);
  });

  it("does no work when an event has no listeners", () => {
    const bus = new EventBus();
    expect(() => bus.emit("dag.updated", { snapshot: { objective: "", createdAt: "", updatedAt: "", nodes: [], completed: 0, failed: 0, pending: 0, done: false }, at: 0 })).not.toThrow();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe("AgentLoop event wiring", () => {
  class FakeRead implements Tool<{ text: string }> {
    readonly name = "read_file";
    readonly description = "fake read";
    readonly readOnly = true;
    readonly category = "read" as const;

    schema() {
      return { name: this.name, description: this.description, input_schema: { type: "object" } };
    }

    parse(input: unknown): { text: string } {
      return input as { text: string };
    }

    async run(input: { text: string }) {
      return { ok: true, output: input.text };
    }
  }

  it("publishes stream and tool events for a streamed tool call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carls-phase4-loop-"));
    const previousAppData = process.env.APPDATA;
    const previousSystem = process.env.CARLS_SYSTEM_CONFIG;
    process.env.APPDATA = join(dir, "appdata");
    process.env.CARLS_SYSTEM_CONFIG = join(dir, "none.json");
    try {
      const logger = new Logger("error");
      const config = loadConfig({ yolo: true, maxSteps: 5 }, dir);
      const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
      const registry = new ToolRegistry();
      registry.register(new FakeRead());

      let turn = 0;
      const provider = {
        name: "scripted",
        async complete(args: {
          onText?: (chunk: string) => void;
          onToolCall?: (call: { type: "tool_use"; id: string; name: string; input: unknown }) => void;
        }) {
          turn++;
          if (turn === 1) {
            args.onText?.("working");
            const toolUse = { type: "tool_use" as const, id: "t1", name: "read_file", input: { text: "observation" } };
            args.onToolCall?.(toolUse);
            return {
              content: [{ type: "text" as const, text: "working" }, toolUse],
              stopReason: "tool_use" as const,
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          return {
            content: [{ type: "text" as const, text: "done" }],
            stopReason: "end_turn" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };

      const events = new EventBus();
      const names: string[] = [];
      const deltas: string[] = [];
      for (const name of ["stream.delta", "tool.start", "tool.done"] as const) {
        events.on(name, () => names.push(name));
      }
      events.on("stream.delta", (event) => deltas.push(event.text));

      const loop = new AgentLoop({
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
        events,
      });

      const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
      const result = await loop.run(history, "go", { onText: () => undefined });

      expect(result.stoppedReason).toBe("completed");
      expect(deltas).toEqual(["working"]);
      expect(names).toEqual(["stream.delta", "tool.start", "tool.done"]);

      // The prefetched observation reached the model as a tool_result.
      const results = history
        .flatMap((message) => message.content)
        .filter((block): block is Extract<Message["content"][number], { type: "tool_result" }> => block.type === "tool_result");
      expect(results[0]?.content).toBe("observation");
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      if (previousSystem === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previousSystem;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not attach a listener to the caller's signal, so a reused signal cannot leak one per run", async () => {
    // A driver may hold one signal for a whole session and pass it to every run.
    // Mirroring it through a private controller would attach an abort listener
    // that never leaves, piling up one closure per run on that shared signal.
    const dir = await mkdtemp(join(tmpdir(), "carls-loop-signal-"));
    try {
      const logger = new Logger("error");
      const config = loadConfig({ yolo: true, maxSteps: 5 }, dir);
      const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
      const registry = new ToolRegistry();
      const provider: import("../src/types/llm.js").Provider = {
        name: "scripted",
        async complete() {
          return {
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const loop = new AgentLoop({
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

      const turn = new AbortController();
      const baseline = getEventListeners(turn.signal, "abort").length;
      for (let run = 0; run < 5; run++) {
        const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
        await loop.run(history, "go", { signal: turn.signal });
      }
      expect(getEventListeners(turn.signal, "abort").length).toBe(baseline);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
