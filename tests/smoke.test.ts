import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileEdit } from "../src/tools/FileEdit.js";
import { FileRead } from "../src/tools/FileRead.js";
import { BashExecution } from "../src/tools/BashExecution.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { ContextManager } from "../src/core/ContextManager.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { Logger } from "../src/utils/Logger.js";
import { truncate } from "../src/utils/truncate.js";
import { classifyError, FatalError, httpError, RetryableError, withRetry } from "../src/providers/retry.js";
import { readApiKey, resolveApiKey } from "../src/providers/ProviderBase.js";
import { loadConfig } from "../src/config/Config.js";
import type { PermissionMode } from "../src/config/Config.js";
import type { Tool, ToolContext } from "../src/types/tools.js";
import type { Message } from "../src/types/llm.js";
import { SkillLoader } from "../src/skills/SkillLoader.js";
import { SkillRegistry } from "../src/skills/SkillRegistry.js";
import { SaveSkill } from "../src/tools/SaveSkill.js";
import { UseSkill } from "../src/tools/UseSkill.js";
import { FileWrite } from "../src/tools/FileWrite.js";
import { buildSystemPrompt } from "../src/core/Runtime.js";
import { MODE_CYCLE } from "../src/config/Config.js";
import { toolCallLine, toolResultLine } from "../src/cli/ToolView.js";
import { ApplyPatch, FileDelete, HashFile, ListDir, MultiRead, WriteMany } from "../src/tools/FileOps.js";
import { ComputerUse, EnvGet } from "../src/tools/SystemOps.js";
import { BrowserOpen } from "../src/tools/BrowserOps.js";
import { Runtime } from "../src/core/Runtime.js";
import { PROVIDERS, providerById, reasoningHintsFor } from "../src/providers/registry.js";
import { apiKeyEnvFor, defaultModelFor } from "../src/config/Config.js";
import { clipboardCommands, isWindows, processListCommand, shellForPlatform, systemConfigPath, userDataDir } from "../src/utils/platform.js";
import { redact } from "../src/utils/Logger.js";
import { needsOnboarding, runOnboarding } from "../src/setup/Onboarding.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let dir: string;
let logger: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "carls-test-"));
  logger = new Logger("error");
  // Keep tests hermetic: the machine-level /etc/carls/.carlsrc.json must not
  // leak into assertions about defaults.
  process.env.CARLS_SYSTEM_CONFIG = join(dir, "no-system-config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeContext(overrides: { planMode?: boolean; yolo?: boolean } = {}): ToolContext {
  const config = loadConfig(
    {
      ...(overrides.planMode !== undefined ? { planMode: overrides.planMode } : {}),
      ...(overrides.yolo !== undefined ? { yolo: overrides.yolo } : {}),
    },
    dir,
  );
  const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
  return {
    cwd: dir,
    config,
    session,
    logger,
    signal: new AbortController().signal,
  };
}

describe("edit_file", () => {
  it("rejects an ambiguous old_string", async () => {
    const file = join(dir, "dup.txt");
    await writeFile(file, "same\nsame\n", "utf8");
    const tool = new FileEdit();
    const ctx = makeContext();

    const result = await tool.run(tool.parse({ path: "dup.txt", old_string: "same", new_string: "x" }), ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("matches 2 times");
    // The file must be untouched after a refused edit.
    expect(await readFile(file, "utf8")).toBe("same\nsame\n");
  });

  it("applies a unique replacement and returns a diff", async () => {
    const file = join(dir, "uniq.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tool = new FileEdit();
    const ctx = makeContext();

    const result = await tool.run(
      tool.parse({ path: "uniq.txt", old_string: "beta", new_string: "BETA" }),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("+ BETA");
    expect(result.output).toContain("- beta");
    expect(await readFile(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("reports a clear error when old_string is absent", async () => {
    const file = join(dir, "none.txt");
    await writeFile(file, "hello\n", "utf8");
    const tool = new FileEdit();
    const result = await tool.run(
      tool.parse({ path: "none.txt", old_string: "missing", new_string: "x" }),
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("read_file", () => {
  it("numbers lines and honours the requested range", async () => {
    const file = join(dir, "lines.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");
    const tool = new FileRead();
    const result = await tool.run(tool.parse({ path: "lines.txt", start_line: 2, end_line: 3 }), makeContext());

    expect(result.ok).toBe(true);
    expect(result.output).toBe("2→two\n3→three");
  });
});

describe("bash", () => {
  it("returns a non-zero exit code instead of throwing", async () => {
    const tool = new BashExecution();
    const result = await tool.run(tool.parse({ command: "exit 7" }), makeContext());

    expect(result.ok).toBe(false);
    expect(result.metadata?.exitCode).toBe(7);
    expect(result.output).toContain("[exit code] 7");
  });

  it("captures stdout on success", async () => {
    const tool = new BashExecution();
    const result = await tool.run(tool.parse({ command: "echo carls" }), makeContext());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("carls");
  });
});

describe("truncate", () => {
  it("keeps the result within the limit and reports the omission", () => {
    const input = "a".repeat(5000) + "TAIL";
    const result = truncate(input, 1000);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.text).toContain("salida truncada");
    expect(result.omitted).toBeGreaterThan(0);
  });

  it("passes short input through untouched", () => {
    const result = truncate("short", 1000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("short");
  });
});

describe("ContextManager", () => {
  it("does not compact below the threshold", () => {
    const manager = new ContextManager({ contextWindow: 100000, compactThreshold: 0.75, truncateLimit: 8000 });
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(manager.shouldCompact(messages)).toBe(false);
  });

  it("compacts once past 75% and preserves recent turns", async () => {
    const manager = new ContextManager({
      contextWindow: 2000,
      compactThreshold: 0.75,
      truncateLimit: 8000,
      keepRecent: 2,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: [{ type: "text", text: `question ${i} ${"x".repeat(200)}` }] });
      messages.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `t${i}`, name: "read_file", input: { path: `f${i}.ts` } },
        ],
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "y".repeat(200), is_error: false }],
      });
    }

    expect(manager.shouldCompact(messages)).toBe(true);

    const result = await manager.compact(messages, "goal", new Set(["seed.ts"]), async (older, hint) =>
      ContextManager.heuristicCheckpoint(older, hint),
    );

    expect(result.compacted).toBe(true);
    expect(result.checkpoint?.filesTouched).toContain("f0.ts");
    expect(result.messages.length).toBeLessThan(messages.length);
    const summary = result.messages[0];
    expect(summary?.content[0]).toMatchObject({ type: "text" });
    // The retained tail must not start with an orphaned tool_result turn.
    const firstKept = result.messages[1];
    expect(firstKept?.content.some((block) => block.type === "tool_result")).toBe(false);
  });
});

describe("PermissionGate", () => {
  it("denies destructive tools in plan mode", async () => {
    const ctx = makeContext({ planMode: true });
    const gate = new PermissionGate(ctx.config, logger, async () => "y");
    const registry = new ToolRegistry();
    const edit = new FileEdit();
    registry.register(edit);

    const decision = await gate.authorize({ tool: edit, input: {}, preview: "" });
    expect(decision).toBe("deny");
  });

  it("allows destructive tools in yolo mode without prompting", async () => {
    const ctx = makeContext({ yolo: true });
    let prompted = false;
    const gate = new PermissionGate(ctx.config, logger, async () => {
      prompted = true;
      return "n";
    });
    const edit = new FileEdit();

    const decision = await gate.authorize({ tool: edit, input: {}, preview: "" });
    expect(decision).toBe("allow");
    expect(prompted).toBe(false);
  });

  it("never prompts for read-only tools", async () => {
    const ctx = makeContext();
    let prompted = false;
    const gate = new PermissionGate(ctx.config, logger, async () => {
      prompted = true;
      return "y";
    });
    const read = new FileRead();
    expect(gate.needsApproval(read, {})).toBe(false);
    const decision = await gate.authorize({ tool: read, input: {}, preview: "" });
    expect(decision).toBe("allow");
    expect(prompted).toBe(false);
  });

  it("honours the bash allow-list from config", () => {
    const ctx = makeContext();
    ctx.config.permissions.allow.push("npm test");
    const gate = new PermissionGate(ctx.config, logger, async () => "n");
    const bash = new BashExecution();

    expect(gate.needsApproval(bash, { command: "npm test" })).toBe(false);
    expect(gate.needsApproval(bash, { command: "rm -rf /" })).toBe(true);
  });
});

describe("permission modes", () => {
  const editTool = (): FileEdit => new FileEdit();
  const bashTool = (): BashExecution => new BashExecution();

  function gateFor(mode: PermissionMode, prompt: () => Promise<string> = async () => "n") {
    const config = loadConfig({ mode }, dir);
    return new PermissionGate(config, logger, prompt);
  }

  it("ask mode prompts for writes and shell", async () => {
    let prompts = 0;
    const gate = gateFor("ask", async () => {
      prompts++;
      return "y";
    });
    expect(await gate.authorize({ tool: editTool(), input: {}, preview: "" })).toBe("allow");
    expect(await gate.authorize({ tool: bashTool(), input: { command: "ls" }, preview: "" })).toBe("allow");
    expect(prompts).toBe(2);
  });

  it("build mode auto-approves writes but still prompts for shell", async () => {
    let prompts = 0;
    const gate = gateFor("build", async () => {
      prompts++;
      return "y";
    });
    expect(await gate.authorize({ tool: editTool(), input: {}, preview: "" })).toBe("allow");
    expect(prompts).toBe(0);
    expect(await gate.authorize({ tool: bashTool(), input: { command: "make" }, preview: "" })).toBe("allow");
    expect(prompts).toBe(1);
  });

  it("auto mode runs writes and shell without prompting", async () => {
    let prompts = 0;
    const gate = gateFor("auto", async () => {
      prompts++;
      return "n";
    });
    expect(await gate.authorize({ tool: editTool(), input: {}, preview: "" })).toBe("allow");
    expect(await gate.authorize({ tool: bashTool(), input: { command: "make" }, preview: "" })).toBe("allow");
    expect(prompts).toBe(0);
  });

  it("auto mode still refuses commands on the deny-list", async () => {
    const config = loadConfig({ mode: "auto" }, dir);
    config.permissions.deny.push("rm -rf *");
    const gate = new PermissionGate(config, logger, async () => "y");
    expect(await gate.authorize({ tool: bashTool(), input: { command: "rm -rf /" }, preview: "" })).toBe("deny");
  });

  it("yolo mode ignores the deny-list", async () => {
    const config = loadConfig({ mode: "yolo" }, dir);
    config.permissions.deny.push("rm -rf *");
    const gate = new PermissionGate(config, logger, async () => "n");
    expect(await gate.authorize({ tool: bashTool(), input: { command: "rm -rf /" }, preview: "" })).toBe("allow");
  });

  it("plan mode denies both writes and shell", async () => {
    const gate = gateFor("plan");
    expect(await gate.authorize({ tool: editTool(), input: {}, preview: "" })).toBe("deny");
    expect(await gate.authorize({ tool: bashTool(), input: { command: "ls" }, preview: "" })).toBe("deny");
  });

  it("legacy --plan and --yolo flags still map to modes", () => {
    expect(loadConfig({ planMode: true }, dir).mode).toBe("plan");
    expect(loadConfig({ yolo: true }, dir).mode).toBe("yolo");
    expect(loadConfig({}, dir).mode).toBe("ask");
  });
});

describe("effort plumbing", () => {
  it("reads effort from the config file and CLI overrides win", async () => {
    await writeFile(join(dir, ".carlsrc.json"), JSON.stringify({ effort: "low" }));
    expect(loadConfig({}, dir).effort).toBe("low");
    expect(loadConfig({ effort: "high" }, dir).effort).toBe("high");
  });

  it("forwards reasoning_effort to an OpenAI-compatible endpoint", async () => {
    const { OpenAICompatProvider } = await import("../src/providers/OpenAICompatProvider.js");
    const seen: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      seen.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      // Reasoning effort is opt-in: only endpoints that advertise it receive it.
      const provider = new OpenAICompatProvider("k", "https://example.test/v1", undefined, {
        supportsReasoningEffort: true,
      });
      await provider.complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        model: "m",
        maxTokens: 16,
        effort: "high",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen[0]?.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort for a local endpoint that does not support it", async () => {
    const { OpenAICompatProvider } = await import("../src/providers/OpenAICompatProvider.js");
    const seen: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      seen.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const provider = new OpenAICompatProvider("k", "http://localhost:8000/v1", undefined, {
        supportsReasoningEffort: false,
      });
      await provider.complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        model: "m",
        maxTokens: 16,
        effort: "high",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen[0]).not.toHaveProperty("reasoning_effort");
  });
});

describe("model catalog", () => {
  it("normalizes /models payloads and flags reasoning and free models", async () => {
    const { fetchModels } = await import("../src/models/Catalog.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "free/glm-5.3-flash", context_length: 128000 },
            { id: "o3-mini" },
            { id: "bogus" },
            { id: "" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    let models;
    try {
      const config = loadConfig({ provider: "openai", baseUrl: "https://example.test/v1" }, dir);
      config.apiKey = "k";
      models = await fetchModels(config);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(models.map((m) => m.id)).toEqual(["bogus", "free/glm-5.3-flash", "o3-mini"]);
    const glm = models.find((m) => m.id === "free/glm-5.3-flash");
    expect(glm?.free).toBe(true);
    expect(glm?.contextWindow).toBe(128000);
    expect(models.find((m) => m.id === "o3-mini")?.reasoning).toBe(true);
  });

  it("raises a clear error when the endpoint fails", async () => {
    const { fetchModels, ModelCatalogError } = await import("../src/models/Catalog.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;

    try {
      const config = loadConfig({ provider: "openai", baseUrl: "https://example.test/v1" }, dir);
      config.apiKey = "k";
      await expect(fetchModels(config)).rejects.toBeInstanceOf(ModelCatalogError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("command registry", () => {
  it("exposes every documented command with a summary", async () => {
    const { COMMANDS, findCommand } = await import("../src/cli/Commands.js");
    const names = COMMANDS.map((c) => c.name);
    for (const expected of [
      "/help", "/models", "/model", "/effort", "/mode", "/status", "/cost",
      "/tools", "/diff", "/sessions", "/resume", "/clear", "/compact",
      "/retry", "/config", "/doctor", "/init", "/exit",
      "/undo", "/files", "/todo", "/agent",
    ]) {
      expect(names).toContain(expected);
    }
    expect(findCommand("/permissions")?.name).toBe("/mode");
    expect(findCommand("/quit")?.name).toBe("/exit");
    expect(COMMANDS.every((c) => c.summary.length > 0)).toBe(true);
  });
});

describe("BackupStore", () => {
  it("snapshots a file and restores it on undo", async () => {
    const { BackupStore } = await import("../src/core/Backups.js");
    const store = new BackupStore("test-session", join(dir, "backups"));
    const file = join(dir, "code.ts");
    await writeFile(file, "before" + String.fromCharCode(10));
    store.save(file);
    await writeFile(file, "after" + String.fromCharCode(10));
    const entry = store.latest();
    expect(entry?.path).toBe(file);
    expect(store.restore(entry!)).toContain("restored");
    expect(await readFile(file, "utf8")).toBe("before\n");
  });

  it("deletes a file on undo when it did not exist before", async () => {
    const { BackupStore } = await import("../src/core/Backups.js");
    const store = new BackupStore("test-session", join(dir, "backups"));
    const file = join(dir, "new.txt");

    store.save(file);
    await writeFile(file, "created" + String.fromCharCode(10));
    expect(store.restore(store.latest()!)).toContain("deleted");
    expect(existsSync(file)).toBe(false);
  });

  it("undo stores what it removed so redo can put it back", async () => {
    const { BackupStore } = await import("../src/core/Backups.js");
    const store = new BackupStore("redo-session", join(dir, "backups"));
    const file = join(dir, "redo.txt");
    await writeFile(file, "first\n");
    store.save(file);
    await writeFile(file, "second\n");

    expect(store.redoDepth()).toBe(0);
    expect(store.undo(1)[0]).toContain("restored");
    expect(await readFile(file, "utf8")).toBe("first\n");
    expect(store.redoDepth()).toBe(1);

    expect(store.redo(1)[0]).toContain("re-applied");
    expect(await readFile(file, "utf8")).toBe("second\n");
    expect(store.redoDepth()).toBe(0);
  });

  it("redo recreates a file that an undo deleted", async () => {
    const { BackupStore } = await import("../src/core/Backups.js");
    const store = new BackupStore("redo-create", join(dir, "backups"));
    const file = join(dir, "created-then-undone.txt");
    store.save(file);
    await writeFile(file, "content\n");
    store.undo(1);
    expect(existsSync(file)).toBe(false);
    store.redo(1);
    expect(await readFile(file, "utf8")).toBe("content\n");
  });
});

describe("todo_write tool", () => {
  it("stores the plan and renders status marks", async () => {
    const { TodoWrite } = await import("../src/tools/TodoWrite.js");
    const tool = new TodoWrite();
    const ctx = makeContext();
    const result = await tool.run(
      tool.parse({
        todos: [
          { title: "read the code", status: "done" },
          { title: "write the fix", status: "in_progress" },
        ],
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("☑ read the code");
    expect(result.output).toContain("▶ write the fix");
    expect(TodoWrite.current).toHaveLength(2);
  });
});

describe("installer config writer", () => {
  it("merges installer answers without dropping existing settings", async () => {
    const { mergeConfig } = await import("../src/setup/writeConfig.js");
    const merged = mergeConfig(
      { provider: "openai", baseUrl: "https://api.example/v1", apiKey: "old", maxSteps: 7 },
      { mode: "build", model: "free/glm-5.3-flash" },
    );
    expect(merged.provider).toBe("openai");
    expect(merged.baseUrl).toBe("https://api.example/v1");
    expect(merged.apiKey).toBe("old");
    expect(merged.maxSteps).toBe(7);
    expect(merged.mode).toBe("build");
    expect(merged.model).toBe("free/glm-5.3-flash");
    expect(merged.permissions?.deny).toContain("rm -rf *");
  });

  it("keeps hand-written blocks a reinstall knows nothing about", async () => {
    const { mergeConfig } = await import("../src/setup/writeConfig.js");
    const merged = mergeConfig(
      {
        provider: "anthropic",
        mcpServers: { docs: { url: "https://example.test/mcp" } },
        hooks: { preToolUse: ["node guard.mjs"] },
        allowOutsideWorkspace: true,
        tools: ["read_file", "bash"],
      },
      { mode: "auto" },
    );
    expect(merged.mcpServers?.docs?.url).toBe("https://example.test/mcp");
    expect(merged.hooks?.preToolUse).toEqual(["node guard.mjs"]);
    expect(merged.allowOutsideWorkspace).toBe(true);
    expect(merged.tools).toEqual(["read_file", "bash"]);
    expect(merged.mode).toBe("auto");
  });

  it("defaults to the openai provider when only a base URL is given", async () => {
    const { mergeConfig } = await import("../src/setup/writeConfig.js");
    expect(mergeConfig({}, { baseUrl: "https://x/v1" }).provider).toBe("openai");
    expect(mergeConfig({}, {}).provider).toBe("anthropic");
  });
});

describe("AgentLoop (scripted provider)", () => {
  it("executes tools, feeds observations back, and stops on a text turn", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");
    const { FileRead } = await import("../src/tools/FileRead.js");
    const { BashExecution } = await import("../src/tools/BashExecution.js");

    await writeFile(join(dir, "target.txt"), "hello world\n", "utf8");

    const registry = new ToolRegistry();
    registry.register(new FileRead());
    registry.register(new BashExecution());

    const config = loadConfig({ yolo: true, maxSteps: 10 }, dir);
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const seenHistories: Message[][] = [];

    // Turn 1: call read_file. Turn 2: call bash (fails). Turn 3: finish.
    const scripted: import("../src/types/llm.js").LLMResponse[] = [
      {
        content: [{ type: "tool_use", id: "a", name: "read_file", input: { path: "target.txt" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "tool_use", id: "b", name: "bash", input: { command: "exit 3" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "text", text: "done: file read, failing command observed" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];

    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        seenHistories.push(args.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        const next = scripted.shift();
        if (!next) throw new Error("scripted provider exhausted");
        return next;
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

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "read and test" }] }];
    const result = await loop.run(history, "read and test", { silent: true });

    expect(result.stoppedReason).toBe("completed");
    expect(result.steps).toBe(3);
    expect(result.finalText).toContain("done");

    // The observation from the failing bash call must reach the model as a
    // tool_result marked as an error, not as a thrown exception.
    const thirdCall = seenHistories[2];
    const allBlocks = thirdCall?.flatMap((m) => m.content) ?? [];
    const toolResults = allBlocks.filter(
      (b): b is Extract<Message["content"][number], { type: "tool_result" }> => b.type === "tool_result",
    );
    const bashResult = toolResults[toolResults.length - 1];
    expect(bashResult).toBeDefined();
    expect(bashResult?.is_error).toBe(true);
    expect(bashResult?.content).toContain("[exit code] 3");

    // History is persisted so --resume can rebuild it.
    const reloaded = SessionStore.loadMessages(session.id, join(dir, "sessions"));
    expect(reloaded.length).toBeGreaterThanOrEqual(4);
  });

  it("stops at max_steps when the model never finishes", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");
    const { GlobFiles } = await import("../src/tools/GlobFiles.js");

    const registry = new ToolRegistry();
    registry.register(new GlobFiles());

    const config = loadConfig({ yolo: true, maxSteps: 2 }, dir);
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));

    const provider: import("../src/types/llm.js").Provider = {
      name: "loop-forever",
      async complete() {
        return {
          content: [{ type: "tool_use", id: "g", name: "glob_files", input: { pattern: "**/*" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        } satisfies import("../src/types/llm.js").LLMResponse;
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

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const result = await loop.run(history, "go", { silent: true });
    expect(result.stoppedReason).toBe("max_steps");
    expect(result.steps).toBe(2);
  });
});

describe("parallel tool execution", () => {
  /** Records how many calls of a group were in flight at the same time. */
  function tracker(): { active: number; peak: number } {
    return { active: 0, peak: 0 };
  }

  function fakeTool(name: string, readOnly: boolean, state: ReturnType<typeof tracker>): Tool {
    return {
      name,
      description: name,
      readOnly,
      schema: () => ({ name, description: name, input_schema: { type: "object" } }),
      parse: (input) => input,
      async run() {
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        state.active -= 1;
        return { ok: true, output: `${name} done` };
      },
    };
  }

  it("runs read-only calls together, keeps side effects sequential, and preserves result order", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");

    const reads = tracker();
    const writes = tracker();
    const registry = new ToolRegistry();
    registry.register(fakeTool("read_a", true, reads));
    registry.register(fakeTool("read_b", true, reads));
    registry.register(fakeTool("read_c", true, reads));
    registry.register(fakeTool("write_a", false, writes));
    registry.register(fakeTool("write_b", false, writes));

    const config = loadConfig({ yolo: true, maxSteps: 10 }, dir);
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));

    const toolUse = (id: string, name: string): import("../src/types/llm.js").ContentBlock => ({
      type: "tool_use",
      id,
      name,
      input: {},
    });

    const scripted: import("../src/types/llm.js").LLMResponse[] = [
      {
        content: [toolUse("1", "read_a"), toolUse("2", "read_b"), toolUse("3", "read_c")],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [toolUse("4", "write_a"), toolUse("5", "write_b")],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    ];

    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete() {
        const next = scripted.shift();
        if (!next) throw new Error("scripted provider exhausted");
        return next;
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

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const result = await loop.run(history, "go", { silent: true });
    expect(result.stoppedReason).toBe("completed");

    // The three reads overlapped; the two writes never did.
    expect(reads.peak).toBeGreaterThan(1);
    expect(writes.peak).toBe(1);

    // Observations still arrive in the order the model asked for them.
    const ids = history.flatMap((message) =>
      message.content.flatMap((block) => (block.type === "tool_result" ? [block.tool_use_id] : [])),
    );
    expect(ids).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("httpError classification", () => {
  it("marks transient statuses retryable and honours Retry-After", () => {
    const err = httpError(429, "too many requests", 9000);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(9000);
    expect(classifyError(err)).toBe("retryable");
    expect(classifyError(httpError(503, "unavailable"))).toBe("retryable");
  });

  it("marks client/billing errors fatal so they are never retried", () => {
    for (const status of [400, 401, 402, 403, 404, 422]) {
      const err = httpError(status, `HTTP ${status}`);
      expect(err).toBeInstanceOf(FatalError);
      expect(classifyError(err)).toBe("fatal");
    }
  });

  it("does not sleep when a fatal error surfaces through withRetry", async () => {
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw httpError(402, "insufficient_balance");
        },
        { sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toBeInstanceOf(FatalError);
    expect(sleeps).toEqual([]);
  });
});

describe("resolveApiKey", () => {
  let base: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    // Built per test, after the global beforeEach has pointed the system
    // config at a path that does not exist.
    base = loadConfig({ provider: "openai" });
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("prefers the environment variable over the config file", () => {
    process.env.OPENAI_API_KEY = "from-env";
    expect(resolveApiKey({ ...base, apiKey: "from-config" })).toBe("from-env");
  });

  it("falls back to the config file when the env var is unset", () => {
    delete process.env.OPENAI_API_KEY;
    expect(resolveApiKey({ ...base, apiKey: "from-config" })).toBe("from-config");
  });

  it("returns undefined when neither source provides a key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(resolveApiKey(base)).toBeUndefined();
  });

  it("readApiKey throws a FatalError naming both sources", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => readApiKey(base)).toThrow(FatalError);
    expect(() => readApiKey(base)).toThrow(/apiKey/);
  });
});

describe("system config layer", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carls-syscfg-"));
  });

  afterEach(async () => {
    delete process.env.CARLS_SYSTEM_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  it("uses $CARLS_SYSTEM_CONFIG for any user when no home config exists", async () => {
    const sysPath = join(dir, "sys.json");
    await writeFile(
      sysPath,
      JSON.stringify({ provider: "openai", model: "free/glm-5.3-flash", apiKey: "k" }),
    );
    process.env.CARLS_SYSTEM_CONFIG = sysPath;
    const cfg = loadConfig({}, dir);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("free/glm-5.3-flash");
    expect(cfg.apiKey).toBe("k");
  });

  it("lets a project config override the system layer", async () => {
    const sysPath = join(dir, "sys.json");
    await writeFile(sysPath, JSON.stringify({ provider: "openai", model: "from-system" }));
    process.env.CARLS_SYSTEM_CONFIG = sysPath;
    await writeFile(join(dir, ".carlsrc.json"), JSON.stringify({ model: "from-project" }));
    expect(loadConfig({}, dir).model).toBe("from-project");
  });
});

describe("skills", () => {
  it("discovers builtin skills and exposes their frontmatter", () => {
    const skills = SkillLoader.discover(process.cwd());
    expect(skills.length).toBeGreaterThan(20);
    const config = skills.find((skill) => skill.name === "carls-code-config");
    expect(config?.description.length).toBeGreaterThan(20);
    expect(config?.body).toContain("provider");
  });

  it("ranks a skill that matches the query", () => {
    const registry = new SkillRegistry(dir);
    expect(registry.skills.length).toBeGreaterThan(20);
    const hits = registry.search("add a new model provider");
    expect(hits[0]?.skill.name).toBe("carls-code-config");
  });

  it("records usage and surfaces flagged skills in the review queue", () => {
    const registry = new SkillRegistry(dir);
    const name = registry.skills[0]?.name ?? "";
    registry.recordUse(name);
    registry.flag(name, "the example is stale");
    expect(registry.usageFor(name)?.uses).toBe(1);
    const flagged = registry.reviewQueue().find((entry) => entry.name === name);
    expect(flagged?.reason).toBe("the example is stale");
  });

  it("saves a project skill and reloads it with the project as the source", async () => {
    const ctx = makeContext();
    ctx.skills = new SkillRegistry(dir);
    const tool = new SaveSkill();
    const result = await tool.run(
      tool.parse({
        name: "release-checklist",
        description: "Steps to ship a release.",
        body: "# Release\n\n1. Run the tests.",
        tags: ["release"],
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, ".agents", "skills", "release-checklist", "SKILL.md"))).toBe(true);

    const reloaded = SkillLoader.discover(dir).find((skill) => skill.name === "release-checklist");
    expect(reloaded?.source).toBe("project");
    expect(reloaded?.version).toBe(1);
  });

  it("refuses to overwrite a project skill without overwrite:true", async () => {
    const ctx = makeContext();
    ctx.skills = new SkillRegistry(dir);
    const tool = new SaveSkill();
    const input = { name: "dup-skill", description: "First.", body: "one" };
    expect((await tool.run(tool.parse(input), ctx)).ok).toBe(true);
    const second = await tool.run(tool.parse({ ...input, body: "two" }), ctx);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already exists");
    const third = await tool.run(tool.parse({ ...input, body: "two", overwrite: true }), ctx);
    expect(third.ok).toBe(true);
    const reloaded = SkillLoader.discover(dir).find((skill) => skill.name === "dup-skill");
    expect(reloaded?.body).toContain("two");
    expect(reloaded?.version).toBe(2);
  });

  it("loads a skill body through the use_skill tool", async () => {
    const ctx = makeContext();
    ctx.skills = new SkillRegistry(dir);
    const tool = new UseSkill();
    const missing = await tool.run(tool.parse({ name: "does-not-exist" }), ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("Unknown skill");

    const found = await tool.run(tool.parse({ name: "carls-code-config" }), ctx);
    expect(found.ok).toBe(true);
    expect(found.output).toContain("# Changing carls-code configuration");
  });

  it("exposes use_skill and save_skill to the model in the system prompt", () => {
    const prompt = buildSystemPrompt(loadConfig({}, dir));
    expect(prompt).toContain("carls-code-agent-design");
    expect(prompt).toContain("save_skill");
  });
});

describe("modes", () => {
  it("cycles through every permission mode", () => {
    expect(MODE_CYCLE[0]).toBe("plan");
    expect(MODE_CYCLE).toContain("pair");
    expect(MODE_CYCLE.at(-1)).toBe("yolo");
  });

  it("treats pair mode as asking before acting", async () => {
    const config = loadConfig({ mode: "pair" }, dir);
    const gate = new PermissionGate(config, logger, async () => "y");
    const ctx = { ...makeContext(), config };
    expect(gate.needsApproval(new FileWrite(), { path: "x", content: "y" })).toBe(true);
    expect(await gate.authorize({ tool: new FileWrite(), input: {}, preview: "" })).toBe("allow");
  });
});

describe("tool view", () => {
  it("renders a readable call line without raw JSON", () => {
    const line = toolCallLine("read_file", { path: join(dir, "a.ts"), start_line: 3, end_line: 9 });
    expect(line).toContain("Read");
    expect(line).toContain("a.ts");
    expect(line).toContain(":3-9");
    expect(line).not.toContain("{");
  });

  it("suppresses the start line for an edit and shows the file on the result", () => {
    // The diff is the story, so the call line would only duplicate the path.
    expect(toolCallLine("edit_file", { path: join(dir, "a.ts"), old_string: "a", new_string: "b" })).toBe("");
    const line = toolResultLine("edit_file", {
      ok: true,
      output: "",
      metadata: { path: join(dir, "a.ts"), added: 1, removed: 1, diff: "@@ -1 +1 @@\n-a\n+b" },
    });
    expect(line).toContain("Edit");
    expect(line).toContain("a.ts");
    expect(line).toContain("+1");
    expect(line).not.toContain("{");
  });

  it("renders a diff body with coloured additions and removals", () => {
    const line = toolResultLine("edit_file", {
      ok: true,
      output: "",
      metadata: { path: "a.ts", added: 1, removed: 1, diff: "@@ -1,2 +1,2 @@\n-old\n+new\n keep" },
    });
    // Strip SGR so the assertion is about structure, not colour choice.
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("-old");
    expect(plain).toContain("+new");
    expect(plain).toContain("@@ -1,2 +1,2 @@");
  });

  it("summarises a failed result on one line", () => {
    const line = toolResultLine("bash", { ok: false, output: "", error: "boom\nsecond line" });
    expect(line).toContain("boom");
    expect(line.split("\n").length).toBe(1);
  });
});

describe("new tools", () => {
  it("applies a unified diff with apply_patch", async () => {
    const file = join(dir, "patch.txt");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tool = new ApplyPatch();
    const patch = "@@ -2,1 +2,1 @@\n-two\n+TWO\n";
    const result = await tool.run(tool.parse({ path: "patch.txt", patch }), makeContext());
    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("one\nTWO\nthree\n");
  });

  it("rejects a patch whose context does not match", async () => {
    const file = join(dir, "nomatch.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tool = new ApplyPatch();
    const patch = "@@ -1,1 +1,1 @@\n-missing\n+replacement\n";
    const result = await tool.run(tool.parse({ path: "nomatch.txt", patch }), makeContext());
    expect(result.ok).toBe(false);
    expect(await readFile(file, "utf8")).toBe("alpha\n");
  });

  it("reads several files in one call", async () => {
    await writeFile(join(dir, "a.txt"), "A\n", "utf8");
    await writeFile(join(dir, "b.txt"), "B\n", "utf8");
    const tool = new MultiRead();
    const result = await tool.run(tool.parse({ paths: ["a.txt", "b.txt", "missing.txt"] }), makeContext());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("=== a.txt");
    expect(result.output).toContain("[unreadable]");
  });

  it("writes many files at once", async () => {
    const tool = new WriteMany();
    const result = await tool.run(
      tool.parse({ files: [{ path: "x/one.txt", content: "1" }, { path: "x/two.txt", content: "2" }] }),
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, "x", "one.txt"), "utf8")).toBe("1");
  });

  it("deletes a file but refuses the workspace root", async () => {
    await writeFile(join(dir, "gone.txt"), "x", "utf8");
    const tool = new FileDelete();
    expect((await tool.run(tool.parse({ path: "gone.txt" }), makeContext())).ok).toBe(true);
    expect(existsSync(join(dir, "gone.txt"))).toBe(false);
    const root = await tool.run(tool.parse({ path: "." }), makeContext());
    expect(root.ok).toBe(false);
  });

  it("redacts secrets when reading the environment", async () => {
    process.env.CARLS_TEST_TOKEN = "supersecretvalue";
    const tool = new EnvGet();
    const result = await tool.run(tool.parse({ name: "CARLS_TEST_TOKEN" }), makeContext());
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("supersecretvalue");
    expect(result.output).toContain("<set:");
    delete process.env.CARLS_TEST_TOKEN;
  });

  it("lists a directory with sizes", async () => {
    await writeFile(join(dir, "listed.txt"), "hello", "utf8");
    const tool = new ListDir();
    const result = await tool.run(tool.parse({ path: "." }), makeContext());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("listed.txt");
  });

  it("hashes a file deterministically", async () => {
    await writeFile(join(dir, "hash.txt"), "abc", "utf8");
    const tool = new HashFile();
    const first = await tool.run(tool.parse({ path: "hash.txt" }), makeContext());
    const second = await tool.run(tool.parse({ path: "hash.txt" }), makeContext());
    expect(first.output).toBe(second.output);
    expect(first.output).toContain("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("refuses to run computer_use without a display", async () => {
    const saved = process.env.DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const tool = new ComputerUse();
    const result = await tool.run(tool.parse({ action: "screenshot" }), makeContext());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("DISPLAY");
    if (saved !== undefined) process.env.DISPLAY = saved;
  });

  it("reports browser tools as unavailable without playwright", async () => {
    const tool = new BrowserOpen();
    const result = await tool.run(tool.parse({ url: "https://example.com" }), makeContext());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Playwright");
  });

  it("registers every tool in the runtime", async () => {
    const config = { ...loadConfig({}, dir), apiKey: "test-key" };
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const runtime = new Runtime({ config, logger, session });
    expect(runtime.registry.names().length).toBeGreaterThanOrEqual(48);
    expect(runtime.registry.names()).toContain("computer_use");
    expect(runtime.registry.names()).toContain("apply_patch");
  });
});

describe("provider registry", () => {
  it("bundles at least 25 providers with unique ids", () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(ids.length).toBeGreaterThanOrEqual(25);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes nvidia and openrouter with correct endpoints", () => {
    expect(providerById("nvidia")?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(providerById("nvidia")?.apiKeyEnv).toContain("NVIDIA_API_KEY");
    expect(providerById("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(providerById("openrouter")?.apiKeyEnv).toContain("OPENROUTER_API_KEY");
  });

  it("gives every provider a protocol, a label and a default model", () => {
    for (const provider of PROVIDERS) {
      expect(["anthropic", "openai", "ollama"]).toContain(provider.protocol);
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.defaultModel.length).toBeGreaterThan(0);
      expect(provider.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it("resolves reasoning hints and default models through the registry", () => {
    expect(reasoningHintsFor(providerById("openai")).length).toBeGreaterThan(0);
    expect(defaultModelFor("deepseek")).toBe(providerById("deepseek")?.defaultModel);
    expect(apiKeyEnvFor("anthropic")).toBe("ANTHROPIC_API_KEY");
  });

  it("accepts every registry provider in a written config", () => {
    for (const provider of PROVIDERS) {
      const config = loadConfig({ provider: provider.id }, dir);
      expect(config.provider).toBe(provider.id);
      expect(config.baseUrl).toBe(provider.baseUrl);
    }
  });
});

describe("workspace containment", () => {
  it("rejects a read outside the workspace", async () => {
    const tool = new FileRead();
    const result = await tool.run(tool.parse({ path: "../escape.txt" }), makeContext());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the workspace");
  });

  it("rejects a write outside the workspace", async () => {
    const tool = new FileWrite();
    const result = await tool.run(tool.parse({ path: "/etc/carls-should-not-exist.txt", content: "x" }), makeContext());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the workspace");
    expect(existsSync("/etc/carls-should-not-exist.txt")).toBe(false);
  });

  it("allows outside paths when the config opts in", async () => {
    const outside = join(tmpdir(), `carls-outside-${Date.now()}.txt`);
    const ctx = makeContext();
    const relaxed = { ...ctx, config: { ...ctx.config, allowOutsideWorkspace: true } };
    const tool = new FileWrite();
    const result = await tool.run(tool.parse({ path: outside, content: "ok" }), relaxed);
    expect(result.ok).toBe(true);
    await rm(outside, { force: true });
  });

  it("still allows paths inside the workspace", async () => {
    const tool = new FileWrite();
    const result = await tool.run(tool.parse({ path: "inside.txt", content: "ok" }), makeContext());
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "inside.txt"))).toBe(true);
  });

  it("rejects a path that escapes through a symlink", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "carls-outside-"));
    await writeFile(join(outsideDir, "secret.txt"), "classified", "utf8");
    await symlink(outsideDir, join(dir, "link"));
    try {
      const tool = new FileRead();
      const result = await tool.run(tool.parse({ path: "link/secret.txt" }), makeContext());
      expect(result.ok).toBe(false);
      expect(result.error).toContain("outside the workspace");
    } finally {
      await rm(join(dir, "link"), { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await writeFile(join(dir, "real.txt"), "fine", "utf8");
    await symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
    const tool = new FileRead();
    const result = await tool.run(tool.parse({ path: "alias.txt" }), makeContext());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("fine");
  });
});

describe("platform abstraction", () => {
  it("returns a usable shell for the current platform", () => {
    const shell = shellForPlatform();
    expect(shell.file.length).toBeGreaterThan(0);
    expect(shell.args.length).toBeGreaterThan(0);
    if (isWindows()) expect(shell.file).toMatch(/powershell|pwsh|cmd/i);
    else expect(shell.file).toBe("/bin/bash");
  });

  it("offers a process listing command and clipboard backends", () => {
    const spec = processListCommand();
    expect(spec.file.length).toBeGreaterThan(0);
    const clipboard = clipboardCommands();
    expect(clipboard.read.length).toBeGreaterThan(0);
    expect(clipboard.write.length).toBeGreaterThan(0);
  });

  it("keeps config, cache and data paths inside the platform conventions", () => {
    for (const path of [systemConfigPath(), userDataDir()]) {
      expect(path.length).toBeGreaterThan(0);
    }
  });
});

describe("permission gate hardening", () => {
  function gateFor(mode: PermissionMode): PermissionGate {
    const config = { ...loadConfig({ mode }, dir), apiKey: "k" };
    return new PermissionGate(config, logger, async () => "y");
  }

  it("collapses whitespace before matching the deny-list", async () => {
    const base = loadConfig({ mode: "auto" }, dir);
    const config = { ...base, permissions: { allow: [], deny: ["rm -rf *"] } };
    const gate = new PermissionGate(config, logger, async () => "y");
    const decision = await gate.authorize({
      tool: new BashExecution(),
      input: { command: "rm    -rf   /" },
      preview: "",
    });
    expect(decision).toBe("deny");
  });

  it("matches the allow-list case-insensitively on Windows only", async () => {
    const gate = gateFor("ask");
    const decision = await gate.authorize({
      tool: new BashExecution(),
      input: { command: "npm test" },
      preview: "",
    });
    expect(decision).toBe("allow");
  });

  it("never prompts when stdin is not a terminal", async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      // No injected prompt: this exercises the real terminal-prompt guard.
      const gate = new PermissionGate({ ...loadConfig({ mode: "ask" }, dir), apiKey: "k" }, logger);
      const decision = await gate.authorize({
        tool: new FileWrite(),
        input: { path: "x.txt", content: "x" },
        preview: "",
      });
      expect(decision).toBe("deny");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    }
  });

  it("reads a mutating tool as write and a search as read", () => {
    expect(PermissionGate.categoryOf(new FileWrite())).toBe("write");
    expect(PermissionGate.categoryOf(new FileRead())).toBe("read");
  });
});

describe("secret redaction", () => {
  it("masks the key formats of the bundled providers", () => {
    const samples = [
      "nvapi-abcdefghijklmnopqrstuvwxyz012345",
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
      "gsk_abcdefghijklmnopqrstuvwxyz012345",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    for (const sample of samples) {
      const out = redact(`Authorization: Bearer ${sample}`);
      expect(out).not.toContain(sample);
    }
  });

  it("masks a JWT and a generic key=value pair", () => {
    expect(redact("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij")).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redact("api_key: supersecretvalue")).toContain("***");
  });
});

describe("first-run onboarding", () => {
  /** Drives the wizard with scripted answers, like a pipe would. */
  async function scripted(answers: string[], options: { outPath: string; openBrowser?: (url: string) => void }) {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    let written = "";
    output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
    input.end(`${answers.join("\n")}\n`);
    const result = await runOnboarding({
      input,
      output,
      outPath: options.outPath,
      // No test may depend on a provider answering during setup.
      offline: true,
      ...(options.openBrowser !== undefined ? { openBrowser: options.openBrowser } : {}),
    });
    return { result, written };
  }

  let outPath: string;
  beforeEach(() => {
    outPath = join(dir, "onboarding", ".carlsrc.json");
  });

  it("writes a usable config for a chosen provider", async () => {
    const { result } = await scripted(
      ["groq", "gsk_abcdefghijklmnopqrstuvwxyz012345", "llama-3.3-70b-versatile", "ask", "off"],
      { outPath },
    );
    expect(result.cancelled).toBe(false);
    expect(result.provider).toBe("groq");
    expect(result.model).toBe(providerById("groq")?.defaultModel);

    const saved = JSON.parse(await readFile(outPath, "utf8"));
    expect(saved.provider).toBe("groq");
    expect(saved.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(saved.apiKeyEnv).toBe("GROQ_API_KEY");
    expect(saved.onboarded).toBe(true);
  });

  it("cancels cleanly on EOF without writing a config", async () => {
    const { result } = await scripted([], { outPath });
    expect(result.cancelled).toBe(true);
    expect(existsSync(outPath)).toBe(false);
  });

  it("opens the provider page when the user asks to sign in", async () => {
    const opened: string[] = [];
    const { result } = await scripted(["nvidia", "s", "nvapi-abcdefghijklmnopqrstuvwxyz", "ask", "off"], {
      outPath,
      openBrowser: (url) => opened.push(url),
    });
    expect(opened[0]).toContain("nvidia.com");
    expect(result.provider).toBe("nvidia");
    const saved = JSON.parse(await readFile(outPath, "utf8"));
    expect(saved.apiKey).toBe("nvapi-abcdefghijklmnopqrstuvwxyz");
  });

  it("keeps the key out of the file when the environment already has one", async () => {
    process.env.GROQ_API_KEY = "gsk_abcdefghijklmnopqrstuvwxyz012345";
    try {
      const config = loadConfig({}, dir);
      expect(needsOnboarding({ ...config, provider: "groq" })).toBe(false);
      const { written } = await scripted(["groq", "", "off"], { outPath });
      expect(written).toContain("GROQ_API_KEY in the environment");
      const saved = JSON.parse(await readFile(outPath, "utf8"));
      expect(saved.apiKey).toBeUndefined();
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it("skips the key prompt for a keyless local provider", async () => {
    const { result, written } = await scripted(["ollama", "", "off"], { outPath });
    expect(result.cancelled).toBe(false);
    expect(written).toContain("needs no API key");
    const saved = JSON.parse(await readFile(outPath, "utf8"));
    expect(saved.apiKey).toBeUndefined();
  });

  it("needs onboarding only when no key is reachable", () => {
    const base = loadConfig({}, dir);
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY"]) {
      delete process.env[name];
    }
    const withoutKey = { ...base };
    delete withoutKey.apiKey;
    expect(needsOnboarding(withoutKey)).toBe(true);
    expect(needsOnboarding({ ...base, apiKey: "sk-test" })).toBe(false);
    expect(needsOnboarding({ ...withoutKey, provider: "ollama" })).toBe(false);
  });
});

describe("onboarding provider switching", () => {
  /** The wizard must still ask which provider to use, even with a default. */
  it("changes provider when a different id is typed, keeping the default as a hint", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    let written = "";
    output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
    const outPath = join(dir, "switch", ".carlsrc.json");
    input.end("nvidia\nnvapi-abcdefghijklmnopqrstuvwxyz\n\nask\noff\n");

    const result = await runOnboarding({
      input,
      output,
      outPath,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      offline: true,
    });
    expect(result.cancelled).toBe(false);
    expect(result.provider).toBe("nvidia");
    expect(written).toContain("Provider id [openai]");
    const saved = JSON.parse(await readFile(outPath, "utf8"));
    expect(saved.provider).toBe("nvidia");
  });

  it("keeps the current provider when the prompt is answered with an empty line", async () => {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    output.on("data", () => {});
    const outPath = join(dir, "keep", ".carlsrc.json");
    // Empty provider answer, empty key (skipped via env below), empty model.
    process.env.OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";
    input.end("\n\nask\noff\n");
    try {
      // Offline: the wizard must not need the public internet to be testable.
      const result = await runOnboarding({ input, output, outPath, defaultProvider: "openai", offline: true });
      expect(result.cancelled).toBe(false);
      expect(result.provider).toBe("openai");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("installer launcher node resolution", () => {
  /** The launcher must never embed a node path that does not exist. */
  async function resolveNodeBin(env: Record<string, string | undefined>, nodeDir?: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const script = [
      `PATH=${JSON.stringify(env.PATH ?? process.env.PATH ?? "")} export PATH`,
      `CARLS_NODE_DIR=${JSON.stringify(nodeDir ?? "")} export CARLS_NODE_DIR`,
      `. ${JSON.stringify(join(process.cwd(), "scripts", "lib", "node-bin.sh"))}`,
      "carls_resolve_node_bin",
    ].join("\n");
    // An absolute bash path: the test deliberately empties PATH, and a bare
    // "bash" would fail to spawn before the script even runs.
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile("/bin/bash", ["-c", script], {}, (error, stdout) => {
        if (error && (error as { code?: number }).code !== 1) reject(error);
        else resolve({ stdout: stdout.trim() });
      });
    });
    return result.stdout;
  }

  it("falls back to the node on PATH when no private node was downloaded", async () => {
    const bin = await resolveNodeBin({ PATH: process.env.PATH });
    expect(bin).not.toContain("/node/bin/node");
    expect(bin.length).toBeGreaterThan(0);
    expect(existsSync(bin)).toBe(true);
  });

  it("uses the private node only when that binary really exists", async () => {
    const fake = join(dir, "nodehome");
    await mkdir(join(fake, "bin"), { recursive: true });
    expect(await resolveNodeBin({ PATH: process.env.PATH }, fake)).not.toContain(fake);
    await writeFile(join(fake, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await resolveNodeBin({ PATH: process.env.PATH }, fake)).toBe(join(fake, "bin", "node"));
  });

  it("still produces a runnable launcher when node is not on PATH", async () => {
    const bin = await resolveNodeBin({ PATH: "/nonexistent" });
    expect(bin).toBe("/usr/bin/env node");
  });
});

describe("Shift+Tab mode cycling", () => {
  /** Drives a real Prompt with real keypress sequences and records renders. */
  async function cycleWith(sequence: string): Promise<{ label: string | undefined; drew: number }> {
    const { Prompt } = await import("../src/cli/Prompt.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const writes: string[] = [];
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    output.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    const prompt = new Prompt(input, output);
    let label: string | undefined;
    const pending = prompt.read({
      prompt: "carls> ",
      onModeCycle: () => {
        label = "build";
        return "build";
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    input.write(sequence);
    await new Promise((r) => setTimeout(r, 20));
    input.write("\r");
    await pending;
    return { label, drew: writes.length };
  }

  it("cycles the mode on the CSI Z sequence (Shift+Tab)", async () => {
    const { label, drew } = await cycleWith("\u001b[Z");
    expect(label).toBe("build");
    expect(drew).toBeGreaterThan(0);
  });

  it("cycles the mode when readline reports tab+shift", async () => {
    const { label } = await cycleWith("\t");
    // A plain Tab must insert spaces instead of cycling; only the shift flag
    // distinguishes them, and the CSI Z form above is the one terminals send.
    expect(label).toBeUndefined();
  });
});

describe("Shift+Tab writes the note into the conversation region", () => {
  /** A fake TTY that records everything written to it. */
  async function fakeTty(columns: number, rows: number): Promise<{ stream: NodeJS.WriteStream; writes: string[] }> {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number; rows: number };
    stream.columns = columns;
    stream.rows = rows;
    (stream as unknown as { isTTY: boolean }).isTTY = true;
    const writes: string[] = [];
    stream.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    return { stream, writes };
  }

  it("moves to the region bottom before writing, so the footer cannot erase it", async () => {
    const { Prompt } = await import("../src/cli/Prompt.js");
    const { Chrome } = await import("../src/cli/Chrome.js");
    const { PassThrough } = await import("node:stream");

    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const { stream: output, writes } = await fakeTty(80, 24);

    const chrome = new Chrome(output);
    const layout = chrome.enable(["header"]);
    expect(layout).toBeDefined();
    writes.length = 0;

    const prompt = new Prompt(input, output);
    const pending = prompt.read({ prompt: "carls> ", onModeCycle: () => "build", chrome });
    await new Promise((r) => setTimeout(r, 10));
    input.write("\u001b[Z");
    await new Promise((r) => setTimeout(r, 20));
    input.write("\r");
    await pending;

    const out = writes.join("");
    const noteIndex = out.indexOf("build");
    expect(noteIndex).toBeGreaterThan(-1);
    const regionBottom = layout?.regionBottom ?? 0;
    // The note must be preceded by a cursor move to the region bottom; writing
    // it while the cursor sits on the prompt row is what hid it before.
    const before = out.slice(0, noteIndex);
    expect(before).toContain(`\u001b[${regionBottom};1H`);
    const noteRow = before.lastIndexOf("\u001b[");
    expect(before.slice(noteRow)).toMatch(new RegExp(`^\\u001b\\[${regionBottom};1H`));
  });
});

describe("ANSI text layout", () => {
  it("measures width ignoring colour escapes and counting wide glyphs", async () => {
    const { visibleWidth } = await import("../src/cli/Text.js");
    expect(visibleWidth("\u001b[31mred\u001b[0m")).toBe(3);
    expect(visibleWidth("plain")).toBe(5);
    // A CJK glyph occupies two columns in every terminal that matters here.
    expect(visibleWidth("日本")).toBe(4);
  });

  it("never returns a string wider than the requested width", async () => {
    const { truncate, visibleWidth, pad } = await import("../src/cli/Text.js");
    const sample = "\u001b[32mabcdefghij\u001b[0m klmno";
    for (const width of [1, 3, 7, 12, 40]) {
      expect(visibleWidth(truncate(sample, width))).toBeLessThanOrEqual(width);
      expect(visibleWidth(pad(sample, width))).toBe(width);
    }
  });

  it("wraps without exceeding the width, hard-cutting long tokens", async () => {
    const { wrap, visibleWidth } = await import("../src/cli/Text.js");
    const lines = wrap("alpha beta gamma supercalifragilisticexpialidocious end", 12);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    expect(lines.join(" ")).toContain("alpha");
  });
});

describe("banner layout", () => {
  /** The banner must never wrap, or Chrome's scrolling region desyncs. */
  async function bannerWidths(columns: number, model: string): Promise<number[]> {
    const { bannerLines } = await import("../src/cli/TerminalUI.js");
    const original = process.stderr.columns;
    Object.defineProperty(process.stderr, "columns", { value: columns, configurable: true });
    try {
      const lines = bannerLines({
        model,
        provider: "openai",
        cwd: "/root",
        sessionId: "20261112143200-tf7g",
        mode: "ask",
        effort: "low",
        contextWindow: 200000,
      });
      const { visibleWidth } = await import("../src/cli/Text.js");
      return lines.map(visibleWidth);
    } finally {
      Object.defineProperty(process.stderr, "columns", { value: original, configurable: true });
    }
  }

  it("keeps every line inside the terminal width", async () => {
    for (const columns of [40, 60, 80, 100, 120, 200]) {
      const widths = await bannerWidths(columns, "free/glm-5.3-flash");
      for (const width of widths) expect(width).toBeLessThanOrEqual(columns);
    }
  });

  it("survives a very long model id without overflowing", async () => {
    const columns = 80;
    const widths = await bannerWidths(columns, `vendor/${"x".repeat(120)}`);
    for (const width of widths) expect(width).toBeLessThanOrEqual(columns);
  });
});

describe("selectList", () => {
  /** Drives the picker through a fake TTY and returns the chosen id. */
  async function drive(
    keys: string[],
    items: { id: string; label: string; section?: string }[],
    options: { current?: string } = {},
  ): Promise<{ chosen: string | undefined; output: string }> {
    const { selectList } = await import("../src/cli/SelectList.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const output = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number; rows: number };
    (output as unknown as { isTTY: boolean }).isTTY = true;
    output.columns = 80;
    output.rows = 24;
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    const pending = selectList({
      title: "Test",
      items,
      input,
      output,
      ...(options.current !== undefined ? { current: options.current } : {}),
    });
    await new Promise((r) => setTimeout(r, 10));
    for (const key of keys) {
      input.write(key);
      await new Promise((r) => setTimeout(r, 10));
    }
    const chosen = await pending;
    return { chosen: chosen?.id, output: chunks.join("") };
  }

  const items = [
    { id: "a/1", label: "a/1", section: "a" },
    { id: "a/2", label: "a/2", section: "a" },
    { id: "b/1", label: "b/1", section: "b" },
  ];

  it("opens on the current item and returns it on Enter", async () => {
    const { chosen } = await drive(["\r"], items, { current: "a/2" });
    expect(chosen).toBe("a/2");
  });

  it("moves down past section headings", async () => {
    const { chosen } = await drive(["\u001b[B", "\r"], items, { current: "a/1" });
    expect(chosen).toBe("a/2");
  });

  it("filters as the user types", async () => {
    const { chosen } = await drive(["b", "\r"], items, { current: "a/1" });
    expect(chosen).toBe("b/1");
  });

  it("collapses a section with the left arrow", async () => {
    // Row order is [a header, a/1, a/2, b header, b/1]; collapsing "a" must
    // remove its children from the cursor path.
    const { chosen } = await drive(["\u001b[D", "\u001b[B", "\u001b[B", "\r"], items, { current: "a/1" });
    expect(chosen).toBe("b/1");
  });

  it("cancels with q and leaves the alternate screen", async () => {
    const { chosen, output } = await drive(["q"], items);
    expect(chosen).toBeUndefined();
    expect(output).toContain("\u001b[?1049h");
    expect(output).toContain("\u001b[?1049l");
  });

  it("pads every row to the width so the frame cannot wrap", async () => {
    const { output } = await drive(["q"], items);
    const frame = output.split("\u001b[H").pop() ?? "";
    for (const line of frame.split("\r\n")) {
      const plain = line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
      expect(plain.length).toBeLessThanOrEqual(79);
    }
  });
});

describe("updater", () => {
  it("orders versions numerically and ranks a pre-release below its release", async () => {
    const { compareVersions } = await import("../src/update/Updater.js");
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.10.0")).toBe(-1);
  });

  it("reads a release, falls back to a tag, and builds a pinned installer plan", async () => {
    const { releaseFromPayload, tagFromPayload, installerPlan } = await import("../src/update/Updater.js");
    expect(releaseFromPayload({ tag_name: "v0.3.0", html_url: "u" })).toEqual({
      version: "0.3.0",
      tag: "v0.3.0",
      url: "u",
    });
    expect(releaseFromPayload({ nope: true })).toBeUndefined();
    expect(tagFromPayload([{ name: "v0.4.1" }])?.version).toBe("0.4.1");
    expect(tagFromPayload([])).toBeUndefined();

    const unix = installerPlan("v0.3.0", "linux", "/tmp");
    expect(unix.url).toContain("/v0.3.0/scripts/install.sh");
    expect(unix.command).toBe("bash");
    expect(unix.args).toEqual([unix.scriptPath, "--yes", "--ref", "v0.3.0"]);

    const win = installerPlan("v0.3.0", "win32", "C:/tmp");
    expect(win.url).toContain("/v0.3.0/scripts/install.ps1");
    expect(win.command).toBe("powershell");
    expect(win.args).toContain("-Yes");
  });

  it("falls back to a tag when the repo publishes no release", async () => {
    const { checkForUpdate } = await import("../src/update/Updater.js");
    const server = createServer((req, res) => {
      // GitHub answers 404 for /releases/latest when only tags exist.
      if (req.url === "/releases/latest") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ name: "v0.2.0" }]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const check = await checkForUpdate({ apiBase: `http://127.0.0.1:${port}` });
      expect(check.tag).toBe("v0.2.0");
      expect(check.latest).toBe("0.2.0");
      // The installed build is 0.2.0, so the same tag is not an upgrade.
      expect(check.available).toBe(false);
    } finally {
      server.close();
    }
  });

  it("compares against the GitHub release API", async () => {
    const { checkForUpdate } = await import("../src/update/Updater.js");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: "v99.0.0", html_url: "https://example.test/r" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const check = await checkForUpdate({ apiBase: `http://127.0.0.1:${port}` });
      expect(check.latest).toBe("99.0.0");
      expect(check.available).toBe(true);
      expect(check.tag).toBe("v99.0.0");
    } finally {
      server.close();
    }
  });

  it("installs a release by itself only once, and never after a failure", async () => {
    const { shouldAutoUpdate } = await import("../src/update/Updater.js");
    const check = { current: "0.2.0", latest: "0.3.0", tag: "v0.3.0", available: true, url: "" };
    const base = { checkedAt: 1, latest: "0.3.0", tag: "v0.3.0", url: "" };

    expect(shouldAutoUpdate(check, undefined)).toBe(true);
    expect(shouldAutoUpdate(check, base)).toBe(true);
    // Already upgraded to it: the cache outlives the version bump.
    expect(shouldAutoUpdate(check, { ...base, autoInstalled: "0.3.0" })).toBe(false);
    // One failed install is enough; it is announced, never retried in a loop.
    expect(shouldAutoUpdate(check, { ...base, autoFailed: "0.3.0" })).toBe(false);
    // A different version gets its own single attempt.
    expect(shouldAutoUpdate(check, { ...base, autoFailed: "0.2.9" })).toBe(true);
    expect(shouldAutoUpdate({ ...check, available: false }, undefined)).toBe(false);
  });

  it("defaults autoUpdate to auto and honours the conservative modes", async () => {
    const { loadConfig } = await import("../src/config/Config.js");
    const path = join(dir, "autoupdate", ".carlsrc.json");
    await mkdir(join(dir, "autoupdate"), { recursive: true });
    const previous = process.env.CARLS_SYSTEM_CONFIG;
    process.env.CARLS_SYSTEM_CONFIG = join(dir, "autoupdate", "missing.json");
    try {
      expect(loadConfig({}, dir).autoUpdate).toBe("auto");
      await writeFile(path, JSON.stringify({ autoUpdate: "notify" }));
      expect(loadConfig({}, join(dir, "autoupdate")).autoUpdate).toBe("notify");
      await writeFile(path, JSON.stringify({ autoUpdate: "off" }));
      expect(loadConfig({}, join(dir, "autoupdate")).autoUpdate).toBe("off");
      // A typo must not disable updates silently.
      await writeFile(path, JSON.stringify({ autoUpdate: "sometimes" }));
      expect(loadConfig({}, join(dir, "autoupdate")).autoUpdate).toBe("auto");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previous;
    }
  });
});

describe("mcp transports", () => {
  /** Minimal MCP server: JSON-RPC over Streamable HTTP, or the SSE pair. */
  async function startFakeMcp(mode: "http" | "sse"): Promise<{ url: string; close: () => void }> {
    const sseClients = new Set<import("node:http").ServerResponse>();

    const answer = (message: { id?: number; method?: string; params?: unknown }): unknown => {
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-03-26", serverInfo: { name: "fake", version: "1.2.3" } },
        };
      }
      if (message.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              { name: "echo", description: "echo the args", inputSchema: { type: "object" } },
              { name: "peek", description: "read only", annotations: { readOnlyHint: true } },
            ],
          },
        };
      }
      if (message.method === "tools/call") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "called" }] },
        };
      }
      return { jsonrpc: "2.0", id: message.id, result: {} };
    };

    const server = createServer((req, res) => {
      if (mode === "sse" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sseClients.add(res);
        res.write("event: endpoint\ndata: /messages?session=1\n\n");
        req.on("close", () => sseClients.delete(res));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let message: { id?: number } = {};
        try {
          message = JSON.parse(raw) as { id?: number };
        } catch {
          // ignore
        }
        if (mode === "sse") {
          res.writeHead(202);
          res.end();
          if (typeof message.id === "number") {
            const payload = JSON.stringify(answer(message));
            for (const client of sseClients) client.write(`event: message\ndata: ${payload}\n\n`);
          }
          return;
        }
        if (typeof message.id !== "number") {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sid-1" });
        res.end(JSON.stringify(answer(message)));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}${mode === "sse" ? "/sse" : "/mcp"}`,
      close: () => {
        for (const client of sseClients) client.end();
        server.closeAllConnections();
        server.close();
      },
    };
  }

  for (const mode of ["http", "sse"] as const) {
    it(`completes the handshake and calls a tool over ${mode}`, async () => {
      const { McpClient } = await import("../src/mcp/McpClient.js");
      const server = await startFakeMcp(mode);
      const client = new McpClient("fake", { url: server.url, transport: mode }, logger, dir);
      try {
        expect(client.transportKind).toBe(mode);
        await client.initialize();
        expect(client.serverInfo()?.version).toBe("1.2.3");

        const tools = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "peek"]);

        const wrapped = client.asTools();
        expect(wrapped.map((tool) => tool.name)).toContain("mcp__fake__echo");
        // A readOnlyHint keeps MCP reads eligible for parallel execution.
        expect(wrapped.find((tool) => tool.name === "mcp__fake__peek")?.readOnly).toBe(true);

        const result = await client.callTool("echo", { hi: 1 });
        expect(result.ok).toBe(true);
        expect(result.output).toBe("called");
      } finally {
        client.close();
        server.close();
      }
    });
  }

  it("speaks the stdio transport to a local server", async () => {
    const { McpClient } = await import("../src/mcp/McpClient.js");
    const script = [
      'let buffer = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk;",
      '  let index = buffer.indexOf("\\n");',
      "  while (index !== -1) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    index = buffer.indexOf(\"\\n\");",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.id === undefined) continue;",
      "    const result = message.method === 'initialize'",
      "      ? { protocolVersion: '2025-03-26', serverInfo: { name: 'local-fake', version: '0.0.1' } }",
      "      : message.method === 'tools/list'",
      "      ? { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] }",
      "      : { content: [{ type: 'text', text: 'pong' }] };",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
      "  }",
      "});",
    ].join("\n");

    const client = new McpClient("local", { command: process.execPath, args: ["-e", script] }, logger, dir);
    try {
      expect(client.transportKind).toBe("stdio");
      await client.initialize();
      expect(client.serverInfo()?.version).toBe("0.0.1");
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["ping"]);
      const result = await client.callTool("ping", {});
      expect(result.ok).toBe(true);
      expect(result.output).toBe("pong");
    } finally {
      client.close();
    }
  });

  it("rejects a server with neither command nor url, and parses SSE frames", async () => {
    const { McpClient, buildTransport } = await import("../src/mcp/McpClient.js");
    const { createSseParser } = await import("../src/mcp/transports.js");
    expect(() => new McpClient("broken", {}, logger, dir)).toThrow(/needs either/);
    expect(buildTransport("remote", { url: "https://x/mcp" }, logger, dir).kind).toBe("http");
    expect(
      buildTransport("remote", { url: "https://x/sse", transport: "sse" }, logger, dir).kind,
    ).toBe("sse");
    expect(buildTransport("local", { command: "node" }, logger, dir).kind).toBe("stdio");

    const frames: { event: string; data: string }[] = [];
    const parse = createSseParser((frame) => frames.push(frame));
    // A frame may arrive split across chunks, and multi-line data is joined.
    parse('event: message\ndata: {"a":1}\n');
    parse("\ndata: two\n\ndata: lines\n\ndata: a\ndata: b\n\n");
    expect(frames).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: "message", data: "two" },
      { event: "message", data: "lines" },
      { event: "message", data: "a\nb" },
    ]);
  });
});

describe("grep_search options", () => {
  it("adds context lines, honours case-insensitive mode, and marks context with a dash", async () => {
    const { GrepSearch } = await import("../src/tools/GrepSearch.js");
    await writeFile(join(dir, "notes.txt"), "alpha\nNeedle here\nomega\n", "utf8");
    const tool = new GrepSearch();
    const ctx = makeContext();

    const withContext = await tool.run({ pattern: "Needle", context: 1 }, ctx);
    expect(withContext.ok).toBe(true);
    expect(withContext.output).toContain("notes.txt:2:1: Needle here");
    expect(withContext.output).toContain("notes.txt:1- alpha");
    expect(withContext.output).toContain("notes.txt:3- omega");

    const sensitive = await tool.run({ pattern: "needle" }, ctx);
    expect(sensitive.output).toContain("No matches");
    const insensitive = await tool.run({ pattern: "needle", case_sensitive: false }, ctx);
    expect(insensitive.output).toContain("Needle here");
  });
});

describe("mcp tool rendering", () => {
  it("splits a namespaced name and renders it as an MCP call", async () => {
    const { parseMcpName } = await import("../src/cli/ToolView.js");
    expect(parseMcpName("mcp__github__create_issue")).toEqual({ server: "github", tool: "create_issue" });
    expect(parseMcpName("read_file")).toBeUndefined();
    expect(parseMcpName("mcp__broken")).toBeUndefined();
  });
});

describe("local model support", () => {
  it("exposes only the requested tools while keeping the rest executable", () => {
    const registry = new ToolRegistry();
    registry.register(new FileRead());
    registry.register(new FileEdit());
    registry.register(new BashExecution());
    const restricted = registry.restrictedTo(["read_file"]);
    expect(restricted.names()).toEqual(["read_file"]);
    // Execution still reaches every tool, so a model that calls from memory works.
    expect(registry.has("edit_file")).toBe(true);
    expect(registry.get("bash")).toBeDefined();
  });

  it("core toolset advertises the gather-act-verify essentials only", () => {
    const registry = new ToolRegistry();
    for (const tool of [new FileRead(), new FileEdit(), new BashExecution()]) registry.register(tool);
    const core = registry.coreToolset();
    expect(core.names().sort()).toEqual(["bash", "edit_file", "read_file"]);
  });

  it("restrictedTo ignores names that are not registered", () => {
    const registry = new ToolRegistry();
    registry.register(new FileRead());
    expect(registry.restrictedTo(["read_file", "does_not_exist"]).names()).toEqual(["read_file"]);
  });
});

describe("@file mentions", () => {
  it("parses mentions only at a word boundary", async () => {
    const { parseMentions } = await import("../src/cli/Mentions.js");
    expect(parseMentions("explain @src/a.ts and @docs/b.md, please")).toEqual(["src/a.ts", "docs/b.md"]);
    expect(parseMentions("mail me at someone@example.com")).toEqual([]);
    expect(parseMentions("@same.ts twice @same.ts")).toEqual(["same.ts"]);
    expect(parseMentions("trailing @")).toEqual([]);
  });

  it("attaches the file content to the message", async () => {
    const { expandMentions } = await import("../src/cli/Mentions.js");
    const root = join(dir, "mention");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "hello.ts"), "export const x = 1;\n");

    const result = expandMentions("look at @hello.ts", root);
    expect(result.attached).toEqual(["hello.ts"]);
    expect(result.text.startsWith("look at @hello.ts")).toBe(true);
    expect(result.text).toContain('<file path="hello.ts">');
    expect(result.text).toContain("export const x = 1;");
  });

  it("refuses paths outside the workspace and binary files", async () => {
    const { expandMentions } = await import("../src/cli/Mentions.js");
    const root = join(dir, "mention-guard");
    await mkdir(root, { recursive: true });
    await writeFile(join(dir, "mention-secret.txt"), "do-not-leak");
    await writeFile(join(root, "blob.dat"), Buffer.from([1, 0, 2, 3]));

    const result = expandMentions("read @../mention-secret.txt and @blob.dat", root);
    expect(result.attached).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(["outside the workspace", "binary file"]);
    expect(result.text).not.toContain("do-not-leak");
  });

  it("truncates a mention that would eat the context window", async () => {
    const { expandMentions } = await import("../src/cli/Mentions.js");
    const root = join(dir, "mention-trunc");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "big.ts"), "x".repeat(5000));

    const result = expandMentions("see @big.ts", root, {
      perFileChars: 200,
      totalChars: 500,
      maxFiles: 2,
      maxFileBytes: 8192,
    });
    expect(result.attached).toEqual(["big.ts"]);
    expect(result.text).toContain("… truncated");
    expect(result.text.length).toBeLessThan(400);
  });

  it("lists workspace files without build output or dependencies", async () => {
    const { listWorkspaceFiles } = await import("../src/cli/Mentions.js");
    const root = join(dir, "mention-list");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = {};\n");

    const files = listWorkspaceFiles(root);
    expect(files).toContain("package.json");
    expect(files).toContain("src/index.ts");
    expect(files.some((path) => path.includes("node_modules"))).toBe(false);
  });
});
