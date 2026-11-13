import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnimationTicker, formatElapsed } from "../src/cli/AnimationTicker.js";
import { Chrome } from "../src/cli/Chrome.js";
import { visibleWidth } from "../src/cli/Text.js";
import { Viewport } from "../src/cli/Viewport.js";
import { Prompt } from "../src/cli/Prompt.js";
import { complete } from "../src/cli/Autocomplete.js";
import { headerBar, toolResultCard, userBlock } from "../src/cli/MessageBlocks.js";
import { listWorkspaceFiles } from "../src/cli/Mentions.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { TERMINAL_RESTORE, restoreTerminal, writeSessionBanner } from "../src/cli/SessionBanner.js";
import { parseArgs, HELP_TEXT } from "../src/cli/ArgsParser.js";
import type { Runtime } from "../src/core/Runtime.js";

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

function indexOf(out: FakeOutput, needle: string): number {
  return text(out).indexOf(needle);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("full-screen alternate buffer", () => {
  it("enters alt/mouse/paste and restores every mode before the banner", () => {
    const out = fakeOutput();
    const chrome = new Chrome(out);
    chrome.enable(["header"], { fullscreen: true, header: "carls v0.3.1 [AGENT: BUILD]" });

    expect(text(out)).toContain("\u001b[?1049h");
    expect(text(out)).toContain("\u001b[?1000h\u001b[?1002h\u001b[?1006h");
    expect(text(out)).toContain("\u001b[?2004h");
    expect(text(out)).toContain("\u001b[?25l");

    chrome.writeRegion("one\n");
    chrome.finishTurn();
    chrome.disable();
    writeSessionBanner(out, "session-123", 3);

    const all = text(out);
    const mouseOff = all.indexOf("\u001b[?1006l");
    const altOff = all.indexOf("\u001b[?1049l");
    const cursor = all.lastIndexOf("\u001b[?25h");
    const banner = all.indexOf("carls --resume session-123");
    expect(mouseOff).toBeGreaterThan(-1);
    expect(altOff).toBeGreaterThan(mouseOff);
    expect(cursor).toBeGreaterThan(altOff);
    expect(banner).toBeGreaterThan(altOff);
    expect(TERMINAL_RESTORE).toContain("\u001b[?2026h");
    expect(TERMINAL_RESTORE).toContain("\u001b[?2026l");
    expect(TERMINAL_RESTORE).toContain("\u001b[?1049l");
  });

  it("keeps the legacy layout and non-TTY output free of alternate-screen sequences", () => {
    const legacy = fakeOutput();
    const chrome = new Chrome(legacy);
    chrome.enable(["header"]);
    chrome.disable();
    expect(text(legacy)).not.toContain("\u001b[?1049h");
    expect(text(legacy)).not.toContain("\u001b[?1006h");

    const piped = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
    expect(Chrome.supported(piped)).toBe(false);
    expect(new Chrome(piped).enable(["header"], { fullscreen: true })).toBeUndefined();
  });

  it("parses --no-alt-screen", () => {
    expect(parseArgs(["--no-alt-screen"]).noAltScreen).toBe(true);
    expect(HELP_TEXT).toContain("--no-alt-screen");
  });
});

describe("virtual viewport and SGR mouse", () => {
  it("scrolls 100 messages without moving the fixed header or composer", () => {
    const out = fakeOutput(80, 24);
    const chrome = new Chrome(out);
    chrome.enable(["header"], { fullscreen: true, header: "FIXED HEADER" });
    chrome.drawPrompt("❯ ", "", 0);
    const layout = chrome.current();
    for (let index = 1; index <= 100; index++) chrome.writeRegion(`message ${index}\n`);
    chrome.finishTurn();

    const viewport = chrome.viewport;
    expect(viewport).toBeDefined();
    expect(viewport?.lineCount).toBeGreaterThanOrEqual(100);
    expect(viewport?.scrollOffset).toBe(0);
    const bottomBar = viewport?.scrollbar().join("") ?? "";

    expect(chrome.handleMouse("\u001b[<64;10;10M")).toBe(true);
    expect(viewport?.scrollOffset).toBe(3);
    expect(chrome.handleScrollKey({ name: "pageup" }, true)).toBe(true);
    const scrolledBar = viewport?.scrollbar().join("") ?? "";
    expect(scrolledBar).not.toBe(bottomBar);
    expect(chrome.current().regionTop).toBe(layout.regionTop);
    expect(chrome.current().promptRow).toBe(layout.promptRow);
    expect(chrome.current().statusRow).toBe(layout.statusRow);

    const afterScroll = text(out);
    expect(afterScroll).toContain("\u001b[1;1H");
    expect(afterScroll).toContain(`\u001b[${layout.composerTop};1H`);

    expect(chrome.handleMouse("\u001b[<65;10;10M")).toBe(true);
    expect(chrome.handleScrollKey({ name: "end" }, true)).toBe(true);
    expect(viewport?.scrollOffset).toBe(0);
    expect(chrome.handleScrollKey({ name: "pagedown" }, true)).toBe(true);
    chrome.disable();
  });

  it("wraps wide lines and exposes a proportional scrollbar", () => {
    const viewport = new Viewport({ width: 10, height: 5 });
    viewport.append(`${"x".repeat(35)}\n`);
    expect(viewport.lineCount).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < 30; index++) viewport.append(`row ${index}\n`);
    expect(viewport.scrollbar(5).join("")).toContain("█");
    viewport.toTop();
    expect(viewport.scrollOffset).toBeGreaterThan(0);
    expect(viewport.pill()).toContain("End");
    viewport.toBottom();
    expect(viewport.scrollOffset).toBe(0);
  });

  it("fits the header, composer and status to the terminal without wide-glyph overflow", () => {
    // A CJK string renders two columns per glyph. Counting UTF-16 units lets a
    // "fitted" line run past the terminal width, wrap into a row the fixed
    // layout never reserved, and shift the whole frame.
    const wide = "計".repeat(60);
    const out = fakeOutput(40, 24);
    const chrome = new Chrome(out);
    chrome.enable([wide], { fullscreen: true, header: wide });
    chrome.setStatus(wide);
    chrome.drawPrompt("❯ ", wide, wide.length);
    chrome.finishTurn();
    chrome.disable();

    // Split on absolute cursor moves, then drop every escape sequence so only
    // printable glyphs remain, and assert no painted row exceeds the terminal.
    const ansi = /\u001b\[[0-9;?]*[A-Za-z]/g;
    const lines = text(out)
      .split(/\u001b\[\d+;\d+H/)
      .flatMap((segment) => segment.split("\n"));
    const overflowing = lines.filter((line) => visibleWidth(line.replace(ansi, "")) > 40);
    expect(overflowing).toEqual([]);
  });
});

describe("agent mode and inspector", () => {
  it("cycles on Tab with an empty fullscreen composer and splits the inspector", async () => {
    const out = fakeOutput(90, 28);
    const input = new PassThrough() as unknown as NodeJS.ReadStream & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (raw: boolean) => void;
    };
    input.isTTY = true;
    input.isRaw = false;
    Object.defineProperty(input, "setRawMode", {
      value: (raw: boolean) => {
        input.isRaw = raw;
      },
    });
    const chrome = new Chrome(out);
    chrome.enable(["header"], { fullscreen: true, header: "HEAD" });
    let cycles = 0;
    const prompt = new Prompt(input, out);
    const pending = prompt.read({
      prompt: "❯ ",
      chrome,
      onModeCycle: () => {
        cycles += 1;
        return "plan";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    input.emit("keypress", "\t", { name: "tab" });
    expect(cycles).toBe(1);
    input.emit("keypress", "\r", { name: "return" });
    await pending;

    chrome.setSidebar(["INSPECTOR", "PLAN 1/1"]);
    expect(chrome.current().dividerColumn).toBeGreaterThan(0);
    expect(chrome.current().contentWidth).toBeLessThan(chrome.current().dividerColumn);
    expect(text(out)).toContain("INSPECTOR");
    chrome.disable();
  });
});

describe("rich conversation blocks", () => {
  it("renders the header, user rail and tool result states", () => {
    const header = headerBar({
      version: "0.3.1",
      mode: "build",
      model: "m",
      provider: "anthropic",
      cwd: "/work/project",
      sessionId: "123456789abc",
    });
    expect(header).toContain("[AGENT: BUILD]");
    expect(header).toContain("[Session #123456789abc]");
    const user = userBlock("haz la landing", "plan", new Date(2026, 0, 1, 12, 34)).join("\n");
    expect(user).toContain("┃");
    expect(user).toContain("12:34 · PLAN");
    const failed = toolResultCard("bash", "npm test", false, 1200, ["exit 1"]).join("\n");
    expect(failed).toContain("✗");
    expect(failed).toContain("bash");
    expect(failed).toContain("1.2s");
  });
});

describe("animation ticker", () => {
  it("advances spinner and live clock while busy and stops with zero timers", () => {
    vi.useFakeTimers();
    const frames: string[] = [];
    const ticker = new AnimationTicker((frame) => frames.push(`${frame.spinner}:${frame.elapsed}`), 80);
    ticker.start();
    expect(ticker.running).toBe(true);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(240);
    expect(frames).toHaveLength(4);
    expect(new Set(frames.map((entry) => entry.split(":")[0])).size).toBeGreaterThan(1);
    expect(frames.at(-1)).toContain("0.2s");
    ticker.stop();
    expect(ticker.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(formatElapsed(1350)).toBe("1.3s");
    vi.useRealTimers();
  });
});

describe("/resume routing and AppData exclusion", () => {
  it("suggests saved sessions, never workspace paths", () => {
    vi.spyOn(SessionStore, "list").mockReturnValue([
      {
        id: "session-one",
        cwd: "C:\\work\\project",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "test",
        path: "C:\\sessions\\one.jsonl",
        turns: 2,
        opening: "haz una landing",
      },
    ]);
    const runtime = { config: { cwd: "C:\\Users\\Administrator" } } as unknown as Runtime;
    const result = complete({ line: "/resume ", cursor: 8, runtime });
    expect(result?.items.map((item) => item.value)).toEqual(["session-one"]);
    expect(result?.items.every((item) => item.kind === "arg")).toBe(true);
    expect(result?.items.map((item) => item.value).join(" ")).not.toContain("AppData");
    const commands = complete({ line: "/res", cursor: 4, runtime });
    expect(commands?.items.every((item) => item.kind === "command")).toBe(true);
  });

  it("keeps AppData out of the @ picker", async () => {
    const root = await mkdtemp(join(tmpdir(), "carls-phase7-"));
    try {
      await mkdir(join(root, "AppData", "Local"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "AppData", "Local", "x.dll"), "x");
      await writeFile(join(root, "src", "main.ts"), "x");
      const files = listWorkspaceFiles(root);
      expect(files).toContain("src/main.ts");
      expect(files.some((file) => file.includes("AppData"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the terminal before the banner on exit", () => {
    const out = fakeOutput();
    restoreTerminal(out);
    const restore = text(out);
    expect(restore).toContain("\u001b[?1049l");
    expect(restore.indexOf("\u001b[?1049l")).toBeLessThan(restore.length);
    out.writes.length = 0;
    writeSessionBanner(out, "abc", 1);
    expect(text(out)).toContain("carls --resume abc");
    expect(text(out).indexOf("\u001b[?1049l")).toBeLessThan(text(out).indexOf("carls --resume abc"));
  });
});
