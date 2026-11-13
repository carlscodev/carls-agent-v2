import { describe, expect, it } from "vitest";

import { detectRole, isFastPath, routeIntent } from "../src/core/IntentRouter.js";
import { EventBus } from "../src/core/EventBus.js";
import { Chrome } from "../src/cli/Chrome.js";
import { countTurns, resumeHydrationLines, summarizeTurns } from "../src/cli/ResumeHydration.js";
import type { Message } from "../src/types/llm.js";

interface FakeOutput {
  isTTY: boolean;
  columns: number;
  rows: number;
  writes: string[];
  write(chunk: string | Uint8Array): boolean;
}

function fakeOutput(columns = 100, rows = 30): FakeOutput {
  const out: FakeOutput = {
    isTTY: true,
    columns,
    rows,
    writes: [],
    write(chunk: string | Uint8Array): boolean {
      out.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  };
  return out;
}

const text = (out: FakeOutput): string => out.writes.join("");

describe("IntentRouter > routeIntent", () => {
  it("classifies bare greetings as the conversational fast path", () => {
    for (const goal of ["hola", "hey", "buenas", "qué tal", "gracias", "ok"]) {
      const decision = routeIntent(goal);
      expect(decision.profile, goal).toBe("CONVERSATIONAL_FAST_PATH");
      expect(isFastPath(decision), goal).toBe(true);
    }
  });

  it("classifies conceptual questions as conversation, not a project", () => {
    const decision = routeIntent("¿qué es un closure?");
    expect(decision.profile).toBe("CONVERSATIONAL_FAST_PATH");
  });

  it("routes a greeting that also names an artifact to power mode", () => {
    const decision = routeIntent("hola, hazme una web con glassmorphism");
    expect(decision.profile).toBe("HEAVY_ARCHITECT_POWER_MODE");
    expect(decision.role).toBe("Web Developer / UI Architect");
    expect(decision.skillHints.length).toBeGreaterThan(0);
  });

  it("routes build verbs to direct work when no artifact is named", () => {
    const decision = routeIntent("arregla el bug de login");
    expect(decision.profile).toBe("DIRECT_CODE_TASK");
    expect(isFastPath(decision)).toBe(false);
  });

  it("treats test and lint requests as direct work", () => {
    expect(routeIntent("corre los tests de TypeScript").profile).toBe("DIRECT_CODE_TASK");
    expect(routeIntent("lint the repo").profile).toBe("DIRECT_CODE_TASK");
  });

  it("escalates to power mode for a 3D game with its domain role", () => {
    const decision = routeIntent("crea un juego 3d en el navegador");
    expect(decision.profile).toBe("HEAVY_ARCHITECT_POWER_MODE");
    expect(decision.role).toBe("3D/2D Browser Game Architect");
  });

  it("escalates to power mode for a backend API", () => {
    const decision = routeIntent("crea una api rest con postgres");
    expect(decision.profile).toBe("HEAVY_ARCHITECT_POWER_MODE");
    expect(decision.role).toBe("Full-Stack / Backend Engineer");
  });

  it("still treats an artifact without a build verb as heavy", () => {
    const decision = routeIntent("necesito un dashboard para ventas");
    expect(decision.profile).toBe("HEAVY_ARCHITECT_POWER_MODE");
  });

  it("treats an empty goal as a fast path and never throws", () => {
    const decision = routeIntent("   ");
    expect(decision.profile).toBe("CONVERSATIONAL_FAST_PATH");
    expect(decision.skillHints).toEqual([]);
  });

  it("normalises accents before matching", () => {
    expect(detectRole("creá un juego 3d")).toBe("3D/2D Browser Game Architect");
    expect(routeIntent("añade autenticación").profile).toBe("DIRECT_CODE_TASK");
  });
});

describe("EventBus > reasoning and thought channels", () => {
  it("delivers reasoning deltas with their provenance", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on("reasoning.delta", ({ text, source }) => seen.push(`${source}:${text}`));
    bus.emit("reasoning.delta", { text: "pienso", source: "reasoning_content", at: 1 });
    off();
    bus.emit("reasoning.delta", { text: "ignorado", source: "reasoning_content", at: 2 });
    expect(seen).toEqual(["reasoning_content:pienso"]);
  });

  it("delivers narrated thoughts by phase", () => {
    const bus = new EventBus();
    const phases: string[] = [];
    bus.on("agent.thought", ({ phase }) => phases.push(phase));
    bus.emit("agent.thought", { phase: "classify", text: "a", at: 1 });
    bus.emit("agent.thought", { phase: "skill", text: "b", at: 2 });
    bus.emit("agent.thought", { phase: "decide", text: "c", at: 3 });
    expect(phases).toEqual(["classify", "skill", "decide"]);
  });

  it("isolates a throwing subscriber so the other panels still run", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("agent.thought", () => {
      throw new Error("panel roto");
    });
    bus.on("agent.thought", ({ text }) => seen.push(text));
    expect(() => bus.emit("agent.thought", { phase: "note", text: "sigue", at: 1 })).not.toThrow();
    expect(seen).toEqual(["sigue"]);
  });
});

describe("Chrome > thinking panel row", () => {
  it("reserves the thought row only while a thought is live", () => {
    const out = fakeOutput(100, 30);
    const chrome = new Chrome(out as unknown as NodeJS.WriteStream);
    const layout = chrome.enable(["hdr"], { fullscreen: true, header: "carls" });
    expect(layout?.thoughtRow).toBe(0);
    chrome.setThought("⠋ Razonando");
    expect(chrome.current().thoughtRow).toBeGreaterThan(0);
    expect(text(out)).toContain("Razonando");
    chrome.setThought(undefined);
    expect(chrome.current().thoughtRow).toBe(0);
  });

  it("stacks the thought row above the phase row", () => {
    const out = fakeOutput(100, 30);
    const chrome = new Chrome(out as unknown as NodeJS.WriteStream);
    chrome.enable(["hdr"], { fullscreen: true, header: "carls" });
    chrome.setThought("pensando");
    chrome.setPhase("[ ● ACT ]");
    const layout = chrome.current();
    expect(layout.thoughtRow).toBeGreaterThan(0);
    expect(layout.phaseRow).toBeGreaterThan(layout.thoughtRow);
  });

  it("ignores the thought row in the inline layout", () => {
    const out = fakeOutput(100, 30);
    const chrome = new Chrome(out as unknown as NodeJS.WriteStream);
    chrome.enable(["hdr"], { fullscreen: false, header: "carls" });
    chrome.setThought("pensando");
    expect(chrome.current().thoughtRow).toBe(0);
  });
});

describe("ResumeHydration", () => {
  const message = (role: "user" | "assistant", blocks: Message["content"]): Message => ({ role, content: blocks });

  const history: Message[] = [
    message("user", [{ type: "text", text: "crea la web" }]),
    message("assistant", [
      { type: "text", text: "Listo, creé index.html" },
      { type: "tool_use", id: "t1", name: "write_file", input: {} },
    ]),
    message("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }]),
    message("user", [{ type: "text", text: "ahora añade dark mode" }]),
    message("assistant", [{ type: "text", text: "Añadí un toggle" }]),
  ];

  it("pairs user turns with the assistant text and tool count that followed", () => {
    const turns = summarizeTurns(history, 3);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.user).toBe("crea la web");
    expect(turns[0]?.assistant).toContain("index.html");
    expect(turns[0]?.toolCalls).toBe(1);
    expect(turns[1]?.user).toBe("ahora añade dark mode");
  });

  it("does not open a new turn for a tool-result-only user message", () => {
    expect(countTurns(history)).toBe(3);
    expect(summarizeTurns(history, 5)).toHaveLength(2);
  });

  it("keeps only the requested number of trailing turns", () => {
    const turns = summarizeTurns(history, 1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBe("ahora añade dark mode");
  });

  it("returns no lines for an empty history", () => {
    expect(resumeHydrationLines([], { width: 80 })).toEqual([]);
  });

  it("renders a header, the turns and a closing rule", () => {
    const lines = resumeHydrationLines(history, { turns: 2, width: 80 });
    expect(lines.join("\n")).toContain("Sesión rehidratada");
    expect(lines.join("\n")).toContain("crea la web");
    expect(lines.join("\n")).toContain("2 turno(s)");
  });

  it("clips a very long assistant summary to one bounded line", () => {
    const long = "x".repeat(5000);
    const lines = resumeHydrationLines([message("user", [{ type: "text", text: "go" }]), message("assistant", [{ type: "text", text: long }])], {
      turns: 1,
      width: 80,
      assistantChars: 50,
    });
    const body = lines.find((line) => line.includes("x"));
    expect(body).toBeDefined();
    expect(body?.length ?? 0).toBeLessThan(120);
  });
});
