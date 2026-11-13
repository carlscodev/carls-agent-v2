import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentLoop,
  EXECUTION_FIRST_CORRECTION,
  isCreationRequest,
  lazyCodeDump,
} from "../src/core/AgentLoop.js";
import { buildSystemPrompt } from "../src/core/SystemPrompt.js";
import { buildSystemPrompt as buildSystemPromptFromRuntime } from "../src/core/Runtime.js";
import { SkillRegistry } from "../src/skills/SkillRegistry.js";
import { discoverSkillsForGoal } from "../src/skills/SkillDiscovery.js";
import { formatSessionBanner, restoreTerminal, TERMINAL_RESTORE } from "../src/cli/SessionBanner.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { PersistentTaskDAG } from "../src/core/PersistentTaskDAG.js";
import { parseArgs } from "../src/cli/ArgsParser.js";
import { FileWrite } from "../src/tools/FileWrite.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { ContextManager } from "../src/core/ContextManager.js";
import { CostTracker } from "../src/core/CostTracker.js";
import { Hooks } from "../src/core/Hooks.js";
import { Logger } from "../src/utils/Logger.js";
import { loadConfig } from "../src/config/Config.js";
import { PromptQueue, collectTypedLines } from "../src/cli/Queue.js";
import { Prompt } from "../src/cli/Prompt.js";
import { visibleWidth } from "../src/cli/Text.js";
import type { Message } from "../src/types/llm.js";

const delay = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function longCodeBlock(): string {
  const body = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join("\n");
  return ["Here is the app:", "```ts", body, "```", "Copy it into a file."].join("\n");
}

describe("Phase 6 system prompt", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carls-phase6-prompt-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("carries the Execution-First mandate, the elite UI standard and the skill autonomy rules", () => {
    const prompt = buildSystemPrompt(loadConfig({}, dir));
    expect(prompt).toContain("Execution-First");
    expect(prompt).toContain("PROHIBIDO imprimir el código fuente en bloques Markdown");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("plan_task");
    expect(prompt).toContain("Glassmorphism");
    expect(prompt).toContain("CERO EMOJIS");
    expect(prompt).toContain("Bento Grid");
    expect(prompt).toContain("Skill auto-discovery");
    expect(prompt).toContain("save_skill");
    expect(prompt).toContain("modern-web-glassmorphism");
    // Runtime must re-export the same builder for the existing imports.
    expect(buildSystemPromptFromRuntime(loadConfig({}, dir))).toBe(prompt);
  });
});

describe("Execution-First guard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carls-phase6-guard-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies creation requests and detects long fenced code", () => {
    expect(isCreationRequest("créame una web")).toBe(true);
    expect(isCreationRequest("hazme un juego 3D")).toBe(true);
    expect(isCreationRequest("construye un backend")).toBe(true);
    expect(isCreationRequest("build me a dashboard")).toBe(true);
    expect(isCreationRequest("arregla el bug de login")).toBe(false);
    expect(isCreationRequest("explica este archivo")).toBe(false);
    expect(lazyCodeDump(longCodeBlock())).toEqual({ language: "ts", lines: 30 });
    expect(lazyCodeDump("```ts\nconst a = 1;\n```")).toBeUndefined();
  });

  it("injects the corrective message and forces the model to write the file", async () => {
    const logger = new Logger("error");
    const config = loadConfig({ yolo: true, maxSteps: 5, provider: "openai", model: "test-model" }, dir);
    config.apiKey = "test-key";
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const registry = new ToolRegistry();
    registry.register(new FileWrite());
    const skills = new SkillRegistry(dir);

    const systems: string[] = [];
    const messageSnapshots: Message[][] = [];
    let call = 0;
    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        call++;
        systems.push(args.system);
        messageSnapshots.push(args.messages.map((message) => ({ role: message.role, content: [...message.content] })));
        if (call === 1) {
          return {
            content: [{ type: "text", text: longCodeBlock() }],
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        if (call === 2) {
          return {
            content: [
              {
                type: "tool_use",
                id: "w1",
                name: "write_file",
                input: { path: "index.html", content: "<!doctype html><title>Built</title>" },
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: [{ type: "text", text: "created index.html" }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 10 },
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
      systemPrompt: buildSystemPrompt(config),
      toolContext: { cwd: dir, config, session, logger },
      skillRegistry: skills,
    });

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "créame una web" }] }];
    const result = await loop.run(history, "créame una web", { silent: true });

    expect(call).toBeGreaterThanOrEqual(3);
    expect(result.stoppedReason).toBe("completed");
    expect(result.finalText).toBe("created index.html");
    expect(existsSync(join(dir, "index.html"))).toBe(true);

    // The auto-discovery block is in the very first system prompt and points at
    // the glassmorphism skill for a web request.
    expect(systems[0]).toContain("[Skill auto-discovery]");
    expect(systems[0]).toContain("modern-web-glassmorphism");

    // The second request sees the corrective observation, not a normal user turn.
    const corrective = messageSnapshots[1]?.flatMap((message) => message.content).find(
      (block) => block.type === "text" && block.text === EXECUTION_FIRST_CORRECTION,
    );
    expect(corrective).toBeDefined();
  });
});

describe("Skill auto-discovery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carls-phase6-skills-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("selects the builtin procedure that matches the operator's goal", () => {
    const registry = new SkillRegistry(dir);

    const web = discoverSkillsForGoal(registry, "créame una web moderna con glassmorphism");
    expect(web.relevant.map((hit) => hit.skill.name)).toContain("modern-web-glassmorphism");
    expect(web.block).toContain("modern-web-glassmorphism");
    expect(web.block).toContain("use_skill");

    const game = discoverSkillsForGoal(registry, "hazme un juego 3D con three.js");
    expect(game.relevant.map((hit) => hit.skill.name)).toContain("tactical-3d-web-game");

    const scaffold = discoverSkillsForGoal(registry, "levanta un proyecto completo desde cero");
    expect(scaffold.relevant.map((hit) => hit.skill.name)).toContain("autonomous-project-scaffold");
  });

  it("does not inject a procedure when nothing matches", () => {
    const registry = new SkillRegistry(dir);
    const result = discoverSkillsForGoal(registry, "xyzzy plugh frobnicate");
    expect(result.relevant).toHaveLength(0);
    expect(result.block).toBe("");
  });
});

describe("clean exit and resume", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carls-phase6-exit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("formats a banner with the session id and the exact resume command", () => {
    const lines = formatSessionBanner("20260101-abcd", 3, 72);
    for (const line of lines) expect(visibleWidth(line)).toBe(72);
    const text = lines.join("\n");
    expect(text).toContain("Sesión guardada");
    expect(text).toContain("ID de sesión : 20260101-abcd");
    expect(text).toContain("3 turnos guardados");
    expect(text).toContain("carls --resume 20260101-abcd");
  });

  it("restores every terminal mode, including a balanced synchronized-output pair", () => {
    const writes: string[] = [];
    const output = { write: (chunk: string) => (writes.push(chunk), true) } as unknown as NodeJS.WriteStream;
    restoreTerminal(output);
    const text = writes.join("");
    expect(text).toBe(TERMINAL_RESTORE);
    expect(text).toContain("\u001b[?2026h");
    expect(text).toContain("\u001b[?2026l");
    expect(text).toContain("\u001b[?2004l");
    expect(text).toContain("\u001b[?25h");
    expect(text).toContain("\u001b[r");
  });

  it("flushes the session log and the persistent plan", async () => {
    const root = join(dir, "sessions");
    const store = new SessionStore(dir, "test-model", undefined, root);
    store.recordMessage({ role: "user", content: [{ type: "text", text: "one" }] });
    store.flush();
    const listed = SessionStore.list(root);
    expect(listed[0]?.id).toBe(store.id);

    const stateDir = join(dir, ".carls", "state");
    const dag = new PersistentTaskDAG(stateDir);
    dag.plan("ship it", [{ title: "write the code" }]);
    dag.save();
    expect(PersistentTaskDAG.load(stateDir)?.snapshot().objective).toBe("ship it");
  });

  it("parses --resume without an id as the latest session", () => {
    expect(parseArgs(["--resume"]).resume).toBe("latest");
    expect(parseArgs(["-r"]).resume).toBe("latest");
  });

  it("finds the most recent session for the current workspace", async () => {
    const root = join(dir, "sessions");
    const older = new SessionStore(dir, "m", "older", root);
    older.recordMessage({ role: "user", content: [{ type: "text", text: "older" }] });
    await delay(5);
    const newer = new SessionStore(dir, "m", "newer", root);
    newer.recordMessage({ role: "user", content: [{ type: "text", text: "newer" }] });
    expect(SessionStore.latestForCwd(dir, root)?.id).toBe("newer");
  });
});

describe("multi-turn REPL input", () => {
  function fakeTty(): {
    input: NodeJS.ReadStream;
    output: NodeJS.WriteStream;
  } {
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
    const output = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number; rows: number };
    output.isTTY = true;
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => undefined);
    return { input, output };
  }

  it("accepts a second prompt after a steering composer has stopped", async () => {
    const { input, output } = fakeTty();
    const queue = new PromptQueue();
    const received: string[] = [];
    const composer = collectTypedLines({
      input,
      output,
      queue,
      echo: false,
      onSubmit: (text) => received.push(text),
    });
    await delay();
    input.write("first\r");
    await delay();
    composer.stop();

    const prompt = new Prompt(input, output);
    const pending = prompt.read({ prompt: "> " });
    await delay();
    input.write("second\r");
    const result = await pending;

    expect(result).toEqual({ type: "line", text: "second" });
    expect(received).toEqual(["first"]);
  });

  it("accepts turn three after the second prompt", async () => {
    const { input, output } = fakeTty();
    const prompt = new Prompt(input, output);

    const first = prompt.read({ prompt: "> " });
    await delay();
    input.write("one\r");
    expect(await first).toEqual({ type: "line", text: "one" });

    const second = prompt.read({ prompt: "> " });
    await delay();
    input.write("two\r");
    expect(await second).toEqual({ type: "line", text: "two" });

    const third = prompt.read({ prompt: "> " });
    await delay();
    input.write("three\r");
    expect(await third).toEqual({ type: "line", text: "three" });
  });
});
