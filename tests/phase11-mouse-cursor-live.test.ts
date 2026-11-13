import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { AnimationTicker, renderAgentFleet } from "../src/cli/AnimationTicker.js";
import { Chrome } from "../src/cli/Chrome.js";
import { claimKeypress, claimMouse, isMouseFragment, splitMouseReports } from "../src/cli/Input.js";

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

function fakeInput(): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = true;
  return input;
}

describe("mouse report filtering", () => {
  it("extracts a wheel report and leaves the surrounding text intact", () => {
    const { text: kept, events, carry } = splitMouseReports("hi\u001b[<64;10;5Mthere");
    expect(kept).toBe("hithere");
    expect(carry).toBe("");
    expect(events).toEqual([{ button: 64, column: 10, row: 5, final: "M" }]);
  });

  it("holds back a report split across two chunks", () => {
    const first = splitMouseReports("a\u001b[<64;1");
    expect(first.text).toBe("a");
    expect(first.events).toEqual([]);
    expect(first.carry).toBe("\u001b[<64;1");
    const second = splitMouseReports(`${first.carry}0;5M`);
    expect(second.text).toBe("");
    expect(second.events).toEqual([{ button: 64, column: 10, row: 5, final: "M" }]);
  });

  it("recognises a bare report fragment so it is never typed", () => {
    expect(isMouseFragment("<64;10;5M")).toBe(true);
    expect(isMouseFragment("<0;1;1m")).toBe(true);
    expect(isMouseFragment("hello")).toBe(false);
    expect(isMouseFragment("64;10")).toBe(false);
  });

  it("never leaks the report into the decoded keypress stream", () => {
    const input = fakeInput();
    const typed: string[] = [];
    const wheel: string[] = [];
    claimKeypress(input, (sequence) => {
      if (sequence !== undefined) typed.push(sequence);
    });
    claimMouse(input, {
      onWheel: (direction) => wheel.push(direction),
      onClick: () => wheel.push("click"),
    });

    input.emit("data", Buffer.from("\u001b[<64;10;5M", "utf8"));
    input.emit("data", Buffer.from("x", "utf8"));

    expect(wheel).toEqual(["up"]);
    expect(typed.join("")).toBe("x");
  });
});

describe("composer caret", () => {
  it("paints a visible caret and parks the physical cursor on the composer", () => {
    const out = fakeOutput();
    const chrome = new Chrome(out);
    chrome.enable(["header"], { fullscreen: true, header: "carls" });
    out.writes.length = 0;

    chrome.drawPrompt("❯ ", "hola", 4);
    expect(text(out)).toContain("▏");
    // Cursor is placed on the prompt row, never on the last conversation row.
    expect(text(out)).toContain(`\u001b[${chrome.current().promptRow};`);

    out.writes.length = 0;
    chrome.finishTurn();
    expect(text(out)).toContain("\u001b[?25h");
    expect(text(out)).toContain(`\u001b[${chrome.current().promptRow};`);
  });
});

describe("live sub-agent fleet row", () => {
  it("shows each child with its live detail and drops the goal once progress arrives", () => {
    const line = renderAgentFleet(
      [
        { role: "explorer", goal: "map the router", detail: "grep_search" },
        { role: "tester", goal: "run the suite" },
      ],
      0,
    );
    expect(line).toContain("2 subagentes");
    expect(line).toContain("explorer");
    expect(line).toContain("grep_search");
    expect(line).toContain("tester");
    expect(line).toContain("run the suite");
  });

  it("uses the singular label for a single child and stays within the width", () => {
    const line = renderAgentFleet([{ role: "explorer", goal: "g" }], 1, 20);
    expect(line).toContain("1 subagente");
    expect(line.length).toBeLessThanOrEqual(20);
  });

  it("reserves a row only while the fleet is live and gives it back when empty", () => {
    const out = fakeOutput();
    const chrome = new Chrome(out);
    chrome.enable(["header"], { fullscreen: true, header: "carls" });
    const idleTop = chrome.current().composerTop;

    chrome.setAgents("⚙ 1 subagente · explorer");
    expect(chrome.current().agentsRow).toBeGreaterThan(0);
    expect(chrome.current().composerTop).toBe(idleTop - 1);

    chrome.setAgents(undefined);
    expect(chrome.current().agentsRow).toBe(0);
    expect(chrome.current().composerTop).toBe(idleTop);
  });

  it("keeps animating the fleet while children run", () => {
    const frames: number[] = [];
    let tick = 0;
    const ticker = new AnimationTicker(() => {
      frames.push(tick);
      tick += 1;
    }, 5);
    ticker.start();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ticker.stop();
        expect(frames.length).toBeGreaterThan(1);
        resolve();
      }, 40);
    });
  });
});
