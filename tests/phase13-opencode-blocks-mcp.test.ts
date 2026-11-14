import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TranscriptStore } from "../src/cli/TranscriptStore.js";
import { renderToolCard, parseMcpToolName, type ToolCardState } from "../src/cli/ToolCards.js";
import { renderMcpDashboard } from "../src/cli/McpCard.js";
import { Chrome } from "../src/cli/Chrome.js";
import { Theme, setTheme, theme } from "../src/cli/Theme.js";
import { visibleWidth } from "../src/cli/Text.js";

const OUTPUT_25 = Array.from({ length: 25 }, (_value, index) => `line ${index + 1}`).join("\n");

function cardRenderer(
  state: ToolCardState,
  output = "one\ntwo\nthree",
  extra: { exitCode?: number; durationMs?: number; name?: string } = {},
): (context: { spinner: string; expanded: boolean }) => string[] {
  return ({ spinner, expanded }) =>
    renderToolCard({
      name: extra.name ?? "bash",
      detail: "npm test",
      state,
      spinner,
      expanded,
      output,
      width: 100,
      durationMs: extra.durationMs ?? 42,
      ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    });
}

describe("Phase 13 reactive transcript blocks", () => {
  let previous: Theme;

  beforeEach(() => {
    previous = theme();
    setTheme(new Theme("dark", 24));
  });

  afterEach(() => {
    setTheme(previous);
  });

  it("mutates tool.start -> tool.done in the same block and removes every spinner", () => {
    const store = new TranscriptStore();
    store.putBlock("tool:1", cardRenderer("running", OUTPUT_25), { state: "running", expandable: true });

    const running = store.render("⠋").join("\n");
    expect(running).toContain("⠋");
    expect(running).toContain("38;2;0;216;255"); // #00D8FF running rail
    expect(store.size()).toBe(1);

    store.putBlock("tool:1", cardRenderer("ok", OUTPUT_25, { exitCode: 0 }), { state: "ok" });
    const done = store.render("⠋").join("\n");
    expect(store.size()).toBe(1);
    expect(done).not.toContain("⠋");
    expect(done).toContain("✓");
    expect(done).toContain("38;2;0;255;136"); // #00FF88 success rail

    store.putBlock("tool:1", cardRenderer("failed", OUTPUT_25, { exitCode: 1, durationMs: 1200 }), {
      state: "failed",
    });
    const failed = store.render("⠋").join("\n");
    expect(failed).toContain("✗");
    expect(failed).toContain("38;2;255;77;77"); // #FF4D4D error rail
    expect(failed).toContain("exit 1");
    expect(failed).not.toContain("⠋");
  });

  it("finalizes any card still running at turn end", () => {
    const store = new TranscriptStore();
    store.putBlock("tool:2", cardRenderer("running"), { state: "running", expandable: true });
    expect(store.hasRunning()).toBe(true);

    const count = store.finalizeRunning(() => () => ["┃ ✗ interrupted"]);
    expect(count).toBe(1);
    expect(store.hasRunning()).toBe(false);
    const text = store.render("⠋").join("\n");
    expect(text).not.toContain("⠋");
    expect(text).toContain("✗ interrupted");
  });

  it("toggles a 25-line output collapsed -> expanded -> collapsed in place", () => {
    const store = new TranscriptStore();
    const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
    store.putBlock("tool:3", cardRenderer("ok", OUTPUT_25, { exitCode: 0 }), {
      state: "ok",
      expandable: true,
    });

    const collapsed = plain(store.render("⠋").join("\n"));
    expect(collapsed).toContain("+21 líneas ocultas");
    expect(collapsed).toContain("line 1");
    expect(collapsed).not.toContain("line 25");

    expect(store.toggle("tool:3")?.expanded).toBe(true);
    const expanded = plain(store.render("⠋").join("\n"));
    expect(expanded).toContain("Mostrando 25 líneas");
    expect(expanded).toContain("line 25");

    expect(store.toggle("tool:3")?.expanded).toBe(false);
    const recollapsed = plain(store.render("⠋").join("\n"));
    expect(recollapsed).toContain("+21 líneas ocultas");
    expect(recollapsed).not.toContain("line 25");
  });

  it("parses and renders an MCP execution card with JSON", () => {
    expect(parseMcpToolName("mcp__demo__echo")).toEqual({ server: "demo", tool: "echo" });
    expect(parseMcpToolName("read_file")).toBeUndefined();

    const text = renderToolCard({
      name: "mcp__demo__echo",
      state: "ok",
      durationMs: 18,
      spinner: "⠋",
      expanded: false,
      width: 100,
      args: { message: "ping" },
      output: '{"ok":true,"uptime":1420}',
    }).join("\n");

    expect(text).toContain("◆ MCP  [demo ▸ echo]");
    expect(text).toContain("├─ args");
    expect(text).toContain("╰─ result");
    expect(text).toContain('"uptime": 1420');
    expect(text).not.toContain("mcp__demo__echo");
  });

  it("renders the MCP dashboard without overflowing the width", () => {
    const lines = renderMcpDashboard(
      [
        { name: "demo", status: "online", transport: "stdio", version: "1.0", latencyMs: 12, tools: ["echo", "env"] },
        { name: "idle", status: "idle", transport: "http", tools: [] },
        { name: "broken", status: "error", transport: "sse", tools: [], error: "connection refused" },
      ],
      { width: 80 },
    );
    const text = lines.join("\n");
    expect(text).toContain("● ONLINE");
    expect(text).toContain("○ IDLE");
    expect(text).toContain("✗ ERROR");
    expect(text).toContain("demo");
    expect(text).toContain("echo");
    expect(text).toContain("connection refused");
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
  });
});

describe("Phase 13 Chrome in-place cards", () => {
  let previous: Theme;

  beforeEach(() => {
    previous = theme();
    setTheme(new Theme("dark", 24));
  });

  afterEach(() => {
    setTheme(previous);
  });

  it("replaces a running card in the viewport and toggles it with Ctrl+O", () => {
    const out = new PassThrough() as unknown as NodeJS.WriteStream & {
      isTTY: boolean;
      columns: number;
      rows: number;
    };
    out.isTTY = true;
    out.columns = 100;
    out.rows = 30;
    out.on("data", () => undefined);
    const chrome = new Chrome(out);
    try {
      chrome.enable([""], { fullscreen: true });

      chrome.writeCard("tool:1", cardRenderer("running", OUTPUT_25), {
        state: "running",
        expandable: true,
      });
      const running = chrome.viewport?.visible(100).join("\n") ?? "";
      expect(running).toContain("⠋");

      chrome.writeCard("tool:1", cardRenderer("ok", OUTPUT_25, { exitCode: 0 }), {
        state: "ok",
      });
      const done = chrome.viewport?.visible(100).join("\n") ?? "";
      expect(done).not.toContain("⠋");
      expect(done).toContain("✓");
      expect(done).toContain("+21 líneas ocultas");

      expect(chrome.toggleCard("tool:1")?.expanded).toBe(true);
      const expanded = chrome.viewport?.visible(100).join("\n") ?? "";
      expect(expanded).toContain("Mostrando 25 líneas");

      expect(chrome.toggleCard("tool:1")?.expanded).toBe(false);
      const recollapsed = chrome.viewport?.visible(100).join("\n") ?? "";
      expect(recollapsed).toContain("+21 líneas ocultas");
    } finally {
      chrome.disable();
    }
  });
});
