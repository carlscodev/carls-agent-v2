import { beforeEach, describe, expect, it } from "vitest";

import { SmoothStreamRenderer, drainBudget, streamCursor, FRAME_MS, STREAM_CURSOR } from "../src/cli/SmoothStream.js";
import {
  ToolBatch,
  batchElapsedMs,
  isGroupable,
  renderToolTree,
  toolDetail,
  toolSummary,
  type ToolEntry,
} from "../src/cli/ToolCards.js";
import {
  EIGHTH_BLOCKS,
  RateWindow,
  renderContextCell,
  renderMeter,
  renderRateCell,
  renderSparkline,
  resample,
} from "../src/cli/StatusHud.js";
import { ToastManager, attachToastBus } from "../src/cli/Toast.js";
import { renderPhaseTimeline, renderShimmerText, SPINNER_FRAMES } from "../src/cli/AnimationTicker.js";
import { MarkdownRenderer } from "../src/cli/Markdown.js";
import { Chrome } from "../src/cli/Chrome.js";
import { EventBus } from "../src/core/EventBus.js";
import { Theme, mixRgb, setTheme } from "../src/cli/Theme.js";
import { visibleWidth } from "../src/cli/Text.js";

interface FakeOutput extends NodeJS.WriteStream {
  isTTY: boolean;
  columns: number;
  rows: number;
  writes: string[];
}

function fakeOutput(columns = 100, rows = 30): FakeOutput {
  const out = {
    isTTY: true,
    columns,
    rows,
    writes: [] as string[],
    write(chunk: string | Uint8Array): boolean {
      out.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  };
  return out as unknown as FakeOutput;
}

function text(out: FakeOutput): string {
  return out.writes.join("");
}

function entry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return { id: "1", name: "read_file", detail: "src/index.ts", summary: "12 lines · 3ms", state: "ok", durationMs: 3, ...overrides };
}

beforeEach(() => {
  // Colour depth is decided once from the environment; pin it so a CI machine
  // with a TTY cannot change what these assertions see.
  setTheme(new Theme("dark", 0));
});

describe("SmoothStream drain budget", () => {
  it("returns nothing for an empty backlog", () => {
    expect(drainBudget(0)).toBe(0);
    expect(drainBudget(-5)).toBe(0);
  });

  it("drains a small backlog at a typewriter pace", () => {
    expect(drainBudget(1)).toBe(1);
    expect(drainBudget(2)).toBe(2);
    expect(drainBudget(30)).toBe(2);
  });

  it("ramps through the mid regime and jumps for a large backlog", () => {
    expect(drainBudget(150)).toBe(4);
    // A large backlog drains a quarter, so a fast model is never slowed.
    expect(drainBudget(1000)).toBe(250);
    expect(drainBudget(151)).toBeGreaterThanOrEqual(2);
  });
});

describe("SmoothStreamRenderer", () => {
  it("queues chunks and releases one frame per tick", () => {
    const drained: string[] = [];
    const stream = new SmoothStreamRenderer({ onDrain: (chunk) => drained.push(chunk), intervalMs: FRAME_MS });
    stream.push("abcdefghij");
    expect(stream.pending).toBe(10);
    expect(drained).toEqual([]);
    stream.tick();
    expect(drained.join("")).toBe("ab");
    expect(stream.pending).toBe(8);
    stream.dispose();
  });

  it("forwards every chunk untouched when smoothing is off", () => {
    const drained: string[] = [];
    const stream = new SmoothStreamRenderer({ onDrain: (chunk) => drained.push(chunk), smooth: false });
    stream.push("hola");
    stream.push(" mundo");
    expect(drained).toEqual(["hola", " mundo"]);
    // The non-TTY path must never create a timer.
    expect(stream.running).toBe(false);
    stream.dispose();
  });

  it("empties the buffer at a boundary and stops the clock", () => {
    const drained: string[] = [];
    const stream = new SmoothStreamRenderer({ onDrain: (chunk) => drained.push(chunk) });
    stream.push("una respuesta larga");
    stream.flushInstant();
    expect(drained.join("")).toBe("una respuesta larga");
    expect(stream.pending).toBe(0);
    expect(stream.running).toBe(false);
    stream.dispose();
  });

  it("drops queued text after dispose", () => {
    const drained: string[] = [];
    const stream = new SmoothStreamRenderer({ onDrain: (chunk) => drained.push(chunk) });
    stream.push("texto");
    stream.dispose();
    stream.push("ignorado");
    expect(stream.pending).toBe(0);
    expect(drained).toEqual([]);
  });
});

describe("stream cursor", () => {
  it("disappears the moment nothing is streaming", () => {
    expect(streamCursor(0, false)).toBeUndefined();
  });

  it("breathes deterministically from the tick", () => {
    setTheme(new Theme("dark", 24));
    const first = streamCursor(3, true);
    const again = streamCursor(3, true);
    expect(first).toBe(again);
    expect(first).toContain(STREAM_CURSOR);
    // A different frame lands on a different luminance.
    expect(streamCursor(12, true)).not.toBe(first);
  });
});

describe("tool grouping", () => {
  it("groups read-only calls and never a mutation", () => {
    expect(isGroupable("read_file")).toBe(true);
    expect(isGroupable("grep_search")).toBe(true);
    expect(isGroupable("bash")).toBe(false);
    expect(isGroupable("edit_file")).toBe(false);
  });

  it("folds a long batch and expands on request", () => {
    const entries = Array.from({ length: 6 }, (_unused, index) => entry({ id: String(index) }));
    const folded = renderToolTree(entries, { width: 60 });
    // Header + three rows + `+3 más` + footer.
    expect(folded).toHaveLength(6);
    expect(text2(folded)).toContain("+3 más");
    const expanded = renderToolTree(entries, { width: 60, expanded: true });
    expect(expanded).toHaveLength(8);
    expect(text2(expanded)).not.toContain("más");
  });

  it("keeps every line inside the requested width", () => {
    const entries = Array.from({ length: 8 }, (_unused, index) =>
      entry({ id: String(index), detail: "src/core/very/deep/path/AgentLoop.ts (L1-120)" }),
    );
    for (const expanded of [false, true]) {
      for (const line of renderToolTree(entries, { width: 52, expanded })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(52);
      }
    }
  });

  it("reports the live long pole as batch elapsed", () => {
    const entries: ToolEntry[] = [
      entry({ id: "a", state: "ok", durationMs: 10 }),
      entry({ id: "b", state: "ok", durationMs: 20 }),
      entry({ id: "c", state: "running", durationMs: 45 }),
    ];
    // Finished work sums; the running entry contributes its own clock, not a sum.
    expect(batchElapsedMs(entries)).toBe(75);
  });

  it("patches a batch entry when its result lands", () => {
    const batch = new ToolBatch();
    batch.add({ id: "x", name: "read_file", detail: "a.ts", summary: "…", state: "running" });
    expect(batch.running).toBe(1);
    expect(batch.settled).toBe(false);
    expect(batch.complete("x", "ok", 7, "7ms")).toBe(true);
    expect(batch.settled).toBe(true);
    expect(batch.complete("missing", "ok", 1)).toBe(false);
  });

  it("flips the accordion", () => {
    const batch = new ToolBatch();
    expect(batch.expanded).toBe(false);
    expect(batch.toggle()).toBe(true);
    expect(batch.expanded).toBe(true);
  });

  it("summarises a finished call from its tool", () => {
    expect(toolSummary("grep_search", 4, "a\nb\n\nc")).toBe("3 matches · 4ms");
    expect(toolSummary("read_file", 9, "l1\nl2")).toBe("2 lines · 9ms");
    expect(toolSummary("bash", 12)).toBe("12ms");
  });

  it("describes a call without the verb", () => {
    expect(toolDetail("read_file", { path: "/tmp/x.ts", start_line: 1, end_line: 20 })).toContain("x.ts");
    expect(toolDetail("grep_search", { pattern: "needle" })).toContain('"needle"');
    expect(toolDetail("glob_files", { pattern: "**/*.ts" })).toContain("**/*.ts");
  });
});

function text2(lines: readonly string[]): string {
  return lines.join("\n");
}

describe("status HUD", () => {
  it("draws a width-exact meter at eighth resolution", () => {
    const meter = renderMeter(0.42, 6);
    expect(visibleWidth(meter)).toBe(6);
    expect(meter).toContain(EIGHTH_BLOCKS[4]);
    expect(renderMeter(1, 6)).toBe("██████");
    expect(renderMeter(0, 6)).toBe("░░░░░░");
  });

  it("renders the context cell with an optional token detail", () => {
    expect(renderContextCell(0.42)).toContain("42%");
    const detailed = renderContextCell(0.5, 6, "50k/200k");
    expect(detailed).toContain("CTX:");
    expect(detailed).toContain("50k/200k");
  });

  it("floors an empty sparkline instead of spiking", () => {
    expect(renderSparkline([], 5)).toBe("▁▁▁▁▁");
    expect(renderSparkline([10, 20, 30], 3)).toBe("▃▆█");
  });

  it("resamples a longer series down to the cell budget", () => {
    expect(resample([1, 2, 3, 4], 2)).toEqual([1.5, 3.5]);
    expect(resample([1], 3)).toEqual([1, 1, 1]);
    expect(resample([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(resample([], 2)).toEqual([0, 0]);
  });

  it("labels the rate cell with the latest sample", () => {
    const cell = renderRateCell([10, 40, 90], 3);
    expect(cell).toContain("tok/s");
    expect(cell).toContain("90");
  });

  it("keeps a bounded ring of samples", () => {
    const window = new RateWindow(3);
    for (const rate of [1, 2, 3, 4]) window.push(rate);
    expect(window.size).toBe(3);
    expect(window.last(3)).toEqual([2, 3, 4]);
    window.push(Number.NaN);
    expect(window.size).toBe(3);
    window.clear();
    expect(window.size).toBe(0);
  });
});

describe("toast manager", () => {
  it("shows, expires and prunes on its own clock", () => {
    let now = 0;
    const timers = new Map<number, () => void>();
    const manager = new ToastManager({
      ttl: 100,
      now: () => now,
      setTimer: (fn) => {
        const id = timers.size + 1;
        timers.set(id, fn);
        return { unref: () => undefined };
      },
      clearTimer: () => undefined,
    });
    manager.show("checkpoint");
    expect(manager.active).toHaveLength(1);
    now = 150;
    expect(manager.prune()).toBe(1);
    expect(manager.active).toHaveLength(0);
  });

  it("keeps at most `max` toasts on screen", () => {
    const manager = new ToastManager({ max: 2, setTimer: () => ({ unref: () => undefined }), clearTimer: () => undefined });
    manager.show("a");
    manager.show("b");
    manager.show("c");
    expect(manager.active.map((toast) => toast.text)).toEqual(["b", "c"]);
    manager.dispose();
  });

  it("draws one fitted line per toast", () => {
    const manager = new ToastManager({ setTimer: () => ({ unref: () => undefined }), clearTimer: () => undefined });
    manager.show("Subagente explorer terminado", "success");
    const lines = manager.render(40);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
    expect(lines[0]).toContain("Subagente");
    manager.dispose();
  });

  it("clears every timer on dispose", () => {
    const cleared: number[] = [];
    let handle = 0;
    const manager = new ToastManager({
      setTimer: () => ({ unref: () => undefined, id: ++handle } as { unref: () => void }),
      clearTimer: () => cleared.push(1),
    });
    manager.show("a");
    manager.show("b");
    manager.dispose();
    expect(cleared).toHaveLength(2);
    expect(manager.active).toHaveLength(0);
  });

  it("translates bus events into toasts", () => {
    const bus = new EventBus();
    const manager = new ToastManager({ setTimer: () => ({ unref: () => undefined }), clearTimer: () => undefined });
    const detach = attachToastBus(bus, manager);
    bus.emit("compaction.layer", { layer: 2, applied: true, tokensBefore: 100, tokensAfter: 40, at: 0 });
    expect(manager.active.some((toast) => toast.text.includes("Capa 2"))).toBe(true);
    bus.emit("subagent.status", { role: "explorer", goal: "map", phase: "done", ok: true, at: 0 });
    expect(manager.active.some((toast) => toast.text.includes("explorer"))).toBe(true);
    detach();
    manager.dispose();
  });

  it("announces an injected skill, a checkpoint and an operator rule", () => {
    const bus = new EventBus();
    const manager = new ToastManager({ setTimer: () => ({ unref: () => undefined }), clearTimer: () => undefined });
    const detach = attachToastBus(bus, manager);
    bus.emit("skill.active", { name: "modern-web-glassmorphism", at: 0 });
    bus.emit("checkpoint.created", { id: "a8f2", files: 12, label: "manual", at: 0 });
    bus.emit("operator.rule", { id: "r1", kind: "correction", at: 0 });
    const texts = manager.active.map((toast) => toast.text);
    expect(texts.some((text) => text.includes("modern-web-glassmorphism"))).toBe(true);
    expect(texts.some((text) => text.includes("a8f2"))).toBe(true);
    expect(texts.some((text) => text.includes("Regla de operador"))).toBe(true);
    detach();
    manager.dispose();
    // Detaching must not leave the subscriptions behind on the bus.
    bus.emit("skill.active", { name: "late", at: 0 });
    expect(manager.active).toHaveLength(0);
  });
});

describe("shimmer and phase timeline", () => {
  it("colours the shimmer per character and is pure in the tick", () => {
    setTheme(new Theme("dark", 24));
    expect(renderShimmerText("ACT", 3)).toBe(renderShimmerText("ACT", 3));
    // The crest moves one column per tick; a full period later it is a new frame.
    expect(renderShimmerText("ACT", 3)).not.toBe(renderShimmerText("ACT", 12));
    // Spaces are never painted, so the wave reads as a moving crest.
    setTheme(new Theme("dark", 0));
    expect(renderShimmerText("A B", 0)).toBe("A B");
  });

  it("shows each phase with its own state glyph", () => {
    const state = {
      think: { status: "done" as const, label: "THINK" },
      act: { status: "running" as const, label: "ACT", elapsed: "0.4s" },
      verify: { status: "pending" as const, label: "VERIFY" },
      tick: 2,
    };
    const line = renderPhaseTimeline(state);
    expect(line).toContain("✓");
    expect(line).toContain("○");
    expect(line).toContain("0.4s");
    expect(line).toContain("VERIFY");
    expect(line).toContain(SPINNER_FRAMES[2 % SPINNER_FRAMES.length] ?? "⠋");
  });

  it("truncates the timeline to the given width", () => {
    const state = {
      think: { status: "running" as const, label: "THINKING" },
      act: { status: "pending" as const, label: "TOOLS" },
      verify: { status: "pending" as const, label: "VERIFY" },
      tick: 0,
    };
    expect(visibleWidth(renderPhaseTimeline(state, 20))).toBeLessThanOrEqual(20);
  });
});

describe("markdown fence projection and cursor", () => {
  it("projects an open fence as a closed box without writing", () => {
    const out = fakeOutput(40);
    const markdown = new MarkdownRenderer(out, 40);
    markdown.push("```ts\n");
    markdown.push("const a = 1;");
    const projection = markdown.projectOpenFence();
    expect(projection).toBeDefined();
    // Top rule, one body row, bottom rule.
    expect(projection).toHaveLength(3);
    expect(projection?.[projection.length - 1]).toContain("╰");
    // The projection is pure: asking twice does not double-close the fence.
    expect(markdown.projectOpenFence()).toHaveLength(3);
  });

  it("appends the breathing cursor to the live tail and drops it on flush", () => {
    const out = fakeOutput(40);
    const markdown = new MarkdownRenderer(out, 40);
    markdown.setLiveTail(true);
    markdown.setCursor("|");
    markdown.push("hola");
    expect(text(out)).toContain("hola|");
    markdown.flush();
    // After the flush the cursor is gone; the complete line remains.
    expect(text(out)).toContain("hola");
    expect(text(out).endsWith("hola|\n")).toBe(false);
  });
});

describe("chrome phase row and toast overlay", () => {
  it("reserves the phase row only while a phase is live", () => {
    const out = fakeOutput(100, 30);
    const chrome = new Chrome(out);
    const layout = chrome.enable(["hdr"], { fullscreen: true, header: "carls" });
    expect(layout?.phaseRow).toBe(0);
    chrome.setPhase("[ ● ACT ]");
    expect(chrome.current().phaseRow).toBeGreaterThan(0);
    expect(text(out)).toContain("[ ● ACT ]");
    chrome.setPhase(undefined);
    expect(chrome.current().phaseRow).toBe(0);
  });

  it("composites a toast over the conversation without shifting it", () => {
    const out = fakeOutput(100, 30);
    const chrome = new Chrome(out);
    chrome.enable(["hdr"], { fullscreen: true, header: "carls" });
    chrome.writeRegion("a conversation line that must stay put\n");
    const before = text(out);
    chrome.setOverlay(["TOAST"]);
    const after = text(out);
    expect(after).toContain("TOAST");
    // The conversation row is repainted in place, not pushed down.
    expect(after.slice(before.length)).toContain("a conversation line");
  });
});

describe("mixRgb", () => {
  it("interpolates and clamps the ratio", () => {
    expect(mixRgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
    expect(mixRgb({ r: 10, g: 20, b: 30 }, { r: 200, g: 200, b: 200 }, -1)).toEqual({ r: 10, g: 20, b: 30 });
    expect(mixRgb({ r: 10, g: 20, b: 30 }, { r: 200, g: 200, b: 200 }, 2)).toEqual({ r: 200, g: 200, b: 200 });
  });
});
