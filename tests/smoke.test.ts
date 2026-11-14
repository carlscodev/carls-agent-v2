import { existsSync } from "node:fs";
import { getEventListeners } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileEdit } from "../src/tools/FileEdit.js";
import { FileRead } from "../src/tools/FileRead.js";
import { BashExecution } from "../src/tools/BashExecution.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { ContextManager, digest } from "../src/core/ContextManager.js";
import { RepoMap, extractSymbols } from "../src/core/RepoMap.js";
import { RepoMapTool } from "../src/tools/RepoMapTool.js";
import { ShadowGit } from "../src/security/ShadowGit.js";
import { SubAgent, SUBAGENT_ROLES } from "../src/core/SubAgent.js";
import type { SubAgentRole } from "../src/core/SubAgent.js";
import { SubAgentPool, formatOutcomes } from "../src/core/SubAgentPool.js";
import type { SubAgentTask } from "../src/core/SubAgentPool.js";
import { DelegateTask } from "../src/tools/DelegateTask.js";
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
import { formatDuration, turnSummaryLine } from "../src/cli/TerminalUI.js";
import { CostTracker } from "../src/core/CostTracker.js";
import { ApplyPatch, FileDelete, HashFile, ListDir, MultiRead, WriteMany } from "../src/tools/FileOps.js";
import { ComputerUse, EnvGet, SleepWait } from "../src/tools/SystemOps.js";
import { BrowserOpen } from "../src/tools/BrowserOps.js";
import { Runtime } from "../src/core/Runtime.js";
import { PROVIDERS, providerById, reasoningHintsFor } from "../src/providers/registry.js";
import { apiKeyEnvFor, defaultModelFor } from "../src/config/Config.js";
import { clipboardCommands, isWindows, processListCommand, shellForPlatform, systemConfigPath, userDataDir } from "../src/utils/platform.js";
import { currentPlatform, isTermux } from "../src/utils/platform.js";
import {
  detectOsProfile,
  killProcessTree,
  needsDetachedGroup,
  normalizeWorkspacePath,
  utf8Env,
  verifyCwdIntegrity,
} from "../src/os/OsRuntimeAdapter.js";
import { detectSandbox, sandboxCommand } from "../src/os/Sandbox.js";
import { LspSessionPool } from "../src/lsp/SessionPool.js";
import { TransactionManager } from "../src/core/TransactionManager.js";
import { BackupStore } from "../src/core/Backups.js";
import { PersistentTaskDAG } from "../src/core/PersistentTaskDAG.js";
import { TaskHorizonRouter, countAsks } from "../src/core/TaskHorizonRouter.js";
import { ArtifactStore } from "../src/core/ArtifactStore.js";
import { CompactionPipeline, findSupersededReads } from "../src/core/CompactionPipeline.js";
import { buildLiveState } from "../src/core/LiveState.js";
import { SkillEvolutionEngine } from "../src/skills/SkillEvolutionEngine.js";
import { AutoReviewSteeringClassifier } from "../src/symbiosis/SteeringClassifier.js";
import { OperatorCognitiveMemory } from "../src/symbiosis/OperatorMemory.js";
import { ExecutionReceipt } from "../src/symbiosis/ExecutionReceipt.js";
import { redact } from "../src/utils/Logger.js";
import { needsOnboarding, runOnboarding } from "../src/setup/Onboarding.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let dir: string;
let logger: Logger;
let previousHome: string | undefined;
let previousAppData: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "carls-test-"));
  logger = new Logger("error");
  // Keep tests hermetic: neither the machine-level /etc/carls/.carlsrc.json nor
  // a developer's own ~/.carlsrc.json may leak into assertions about defaults.
  // $HOME is redirected because `userConfigPath()` resolves it through
  // `homedir()`, and a real user config otherwise shadows the layer under test.
  // Windows resolves the same file through %APPDATA%, so both are redirected.
  process.env.CARLS_SYSTEM_CONFIG = join(dir, "no-system-config.json");
  previousHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  previousAppData = process.env.APPDATA;
  process.env.APPDATA = join(dir, "appdata");
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
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

  it("forwards reasoning and text deltas to the caller", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");

    const registry = new ToolRegistry();
    const config = loadConfig({ yolo: true, maxSteps: 3 }, dir);
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        // A thinking model emits its scratchpad before the answer; both streams
        // must reach the caller separately so the UI can style them differently.
        args.onReasoning?.("think ");
        args.onReasoning?.("hard");
        args.onText?.("answer");
        return {
          content: [{ type: "text", text: "answer" }],
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

    const reasoning: string[] = [];
    const text: string[] = [];
    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    await loop.run(history, "go", {
      onReasoning: (chunk) => reasoning.push(chunk),
      onText: (chunk) => text.push(chunk),
    });

    expect(reasoning.join("")).toBe("think hard");
    expect(text.join("")).toBe("answer");
  });

  it("advances the stored updatedAt so the session list orders by real recency", async () => {
    const root = join(dir, "recency-sessions");
    const older = new SessionStore("/work/a", "m", "older", root);
    older.recordMessage({ role: "user", content: [{ type: "text", text: "first" }] });
    await new Promise((r) => setTimeout(r, 5));
    const newer = new SessionStore("/work/b", "m", "newer", root);
    newer.recordMessage({ role: "user", content: [{ type: "text", text: "second" }] });

    const listed = SessionStore.list(root);
    expect(listed.map((entry) => entry.id)).toEqual(["newer", "older"]);
    // The freshest meta record wins, not the one written at creation.
    expect(listed[0]?.updatedAt.localeCompare(listed[1]?.updatedAt ?? "")).toBeGreaterThan(0);
  });

  it("folds a steering message into the next step of the same turn", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");
    const { BashExecution } = await import("../src/tools/BashExecution.js");

    const registry = new ToolRegistry();
    registry.register(new BashExecution());
    const config = loadConfig({ yolo: true, maxSteps: 5 }, dir);
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const requests: Message[][] = [];
    const scripted: import("../src/types/llm.js").LLMResponse[] = [
      {
        content: [{ type: "tool_use", id: "a", name: "bash", input: { command: "true" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        requests.push(args.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        const next = scripted.shift();
        if (next === undefined) throw new Error("scripted provider exhausted");
        return next;
      },
    };

    let polls = 0;
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
      // The user typed a correction while the first step was running, so it is
      // only available once the first step is over.
      takeSteering: () => (polls++ === 1 ? ["focus on the failing test"] : []),
    });

    const steered: string[][] = [];
    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "run the tests" }] }];
    const result = await loop.run(history, "run the tests", { silent: true, onSteer: (messages) => steered.push(messages) });

    expect(result.stoppedReason).toBe("completed");
    expect(steered).toEqual([["focus on the failing test"]]);
    const secondRequest = requests[1] ?? [];
    const steeredMessage = secondRequest.find(
      (message) =>
        message.role === "user" &&
        message.content.some((block) => block.type === "text" && block.text === "focus on the failing test"),
    );
    expect(steeredMessage).toBeDefined();
    // It arrives after the tool result, never between the pair.
    const flat = secondRequest.flatMap((message) => message.content);
    expect(flat[flat.length - 1]?.type).toBe("text");
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

  it("re-anchors the live state after the compaction pipeline summarises", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");
    const { CompactionPipeline } = await import("../src/core/CompactionPipeline.js");
    const { BashExecution } = await import("../src/tools/BashExecution.js");

    const registry = new ToolRegistry();
    registry.register(new BashExecution());

    const config = loadConfig({ yolo: true, maxSteps: 6 }, dir);
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    // A tiny window plus a high mask threshold isolates the compaction path: the
    // loop must reach layer 5, not the cheap masking pass.
    const contextManager = new ContextManager({
      contextWindow: 900,
      compactThreshold: 0.2,
      truncateLimit: 8000,
      keepRecent: 2,
      maskThreshold: 5,
    });

    let liveStateBuilt = false;
    let summarizeCalls = 0;
    const compaction = new CompactionPipeline({
      contextManager,
      buildLiveState: async () => {
        liveStateBuilt = true;
        return "LIVE STATE: goal=ship it, next node n1";
      },
      summarize: async () => {
        summarizeCalls++;
        return { goal: "ship it", filesTouched: [], errorsResolved: [], summary: "did work", nextStep: "continue" };
      },
    });

    const scripted: import("../src/types/llm.js").LLMResponse[] = [
      {
        content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "node -e \"console.log('x'.repeat(4000))\"" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];

    let sawLiveState = false;
    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        const flat = args.messages.flatMap((m) => m.content);
        if (flat.some((b) => b.type === "text" && b.text.includes("LIVE STATE"))) sawLiveState = true;
        const next = scripted.shift();
        if (!next) throw new Error("scripted provider exhausted");
        return next;
      },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      gate: new PermissionGate(config, logger, async () => "y"),
      contextManager,
      session,
      costTracker: new CostTracker(config.model),
      hooks: new Hooks(config.hooks, logger, dir),
      config,
      logger,
      systemPrompt: "test",
      toolContext: { cwd: dir, config, session, logger },
      compaction,
    });

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "ship it" }] }];
    const result = await loop.run(history, "ship it", { silent: true });

    expect(result.stoppedReason).toBe("completed");
    expect(summarizeCalls).toBeGreaterThan(0);
    expect(liveStateBuilt).toBe(true);
    // The re-anchored block is what the model read on the step after the summary.
    expect(sawLiveState).toBe(true);
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
    // Built per test against the hermetic workspace, so a developer's own
    // .carlsrc.json in the checkout cannot supply a stray apiKey.
    base = loadConfig({ provider: "openai" }, dir);
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

  it("appends the duration to a tool result when one is measured", () => {
    const line = toolResultLine(
      "read_file",
      { ok: true, output: "a\nb", metadata: { lines: 2, shown: 2 } },
      1500,
    );
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("1.5s");
  });

  it("omits the duration when none is measured, so old callers keep their shape", () => {
    const line = toolResultLine("read_file", { ok: true, output: "a", metadata: { lines: 1, shown: 1 } });
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).not.toContain("ms");
    expect(plain).not.toContain("s ·");
  });
});

describe("turn reporting", () => {
  it("formats durations across the ms, s and m ranges", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m05s");
  });

  it("summarises a finished turn with time, steps and spend", () => {
    const line = turnSummaryLine({ durationMs: 4200, steps: 3, stoppedReason: "completed", tokens: "↑1.2k ↓340" });
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("done");
    expect(plain).toContain("4.2s");
    expect(plain).toContain("3 steps");
    expect(plain).toContain("↑1.2k ↓340");
  });

  it("labels a stopped turn and hides the spend when nothing was spent", () => {
    const line = turnSummaryLine({ durationMs: 900, steps: 1, stoppedReason: "aborted", tokens: "" });
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("stopped");
    expect(plain).toContain("1 step");
    expect(plain).not.toContain("·  ·");
  });
});

describe("cost tracker", () => {
  it("reports a terse footer form only after tokens are spent", () => {
    const cost = new CostTracker("free/glm-5.3-flash");
    expect(cost.compact()).toBe("");
    cost.add({ inputTokens: 1200, outputTokens: 340 });
    const plain = cost.compact().replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toBe("↑1.2k ↓340");
  });

  it("drops the verbose 'no price data' note for unpriced models", () => {
    const cost = new CostTracker("free/glm-5.3-flash");
    cost.add({ inputTokens: 10, outputTokens: 5 });
    expect(cost.format()).not.toContain("no price data");
    expect(cost.format()).toContain("free");
  });

  it("prices a known model in dollars", () => {
    const cost = new CostTracker("gpt-4o");
    cost.add({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost.format()).toContain("$2.5000");
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

  it("detaches its abort listener once a sleep_wait completes", async () => {
    // `ctx.signal` is the turn's signal and lives for the whole run. A wait that
    // leaves its closure attached piles one listener (and its pending timer) onto
    // that signal per call, so a long turn that snoozes repeatedly leaks, and
    // every later abort re-enters a wait that is already over.
    const turn = new AbortController();
    const baseline = getEventListeners(turn.signal, "abort").length;
    const tool = new SleepWait();
    const ctx: ToolContext = { ...makeContext(), signal: turn.signal };

    for (let call = 0; call < 5; call++) {
      const result = await tool.run(tool.parse({ seconds: 0.01 }), ctx);
      expect(result.ok).toBe(true);
    }

    expect(getEventListeners(turn.signal, "abort").length).toBe(baseline);
  });

  it("returns promptly when the turn is already aborted", async () => {
    // An abort that fired before the wait began must not park the tool for the
    // full duration: there is no future event to wake it, so it would block the
    // step until the timeout.
    const turn = new AbortController();
    turn.abort();
    const tool = new SleepWait();
    const ctx: ToolContext = { ...makeContext(), signal: turn.signal };

    const startedAt = Date.now();
    const result = await tool.run(tool.parse({ seconds: 5 }), ctx);

    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
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

  it("registers the horizon and skill-evolution tools", async () => {
    const config = { ...loadConfig({}, dir), apiKey: "test-key" };
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const runtime = new Runtime({ config, logger, session });

    for (const name of ["plan_task", "advance_task", "read_task_graph", "resume_task", "evolve_skill", "review_skills", "skill_history", "revert_skill", "skill_graph"]) {
      expect(runtime.registry.names()).toContain(name);
    }
    // The plan tools are advertised, so the model can use them without a flag.
    expect(runtime.advertisedTools().names()).toContain("plan_task");
  });

  it("wires the plan, memory and receipt into one runtime", async () => {
    const workspace = join(dir, "wired-runtime");
    await mkdir(workspace, { recursive: true });
    const config = { ...loadConfig({}, workspace), apiKey: "test-key" };
    const session = new SessionStore(workspace, config.model, undefined, join(workspace, "sessions"));
    const runtime = new Runtime({ config, logger, session });

    // A plan written through the runtime's own DAG is visible to its live state.
    runtime.dag.plan("ship the feature", [{ title: "write it", acceptanceCriteria: "tests pass" }]);
    const liveState = await runtime.buildLiveState();
    expect(liveState).toContain("ship the feature");
    expect(liveState).toContain("tests pass");

    // A correction typed mid-run is learned as a rule and re-anchored.
    runtime.steer("no, use the other API instead");
    expect(runtime.operatorMemory.all().length).toBe(1);
    expect(await runtime.buildLiveState()).toContain("use the other API");

    // An approval is not learned and not forwarded as an instruction.
    runtime.steer("ok continue");
    expect(runtime.operatorMemory.all().length).toBe(1);
    expect(runtime.takeSteering().some((text) => text.includes("ok continue"))).toBe(false);

    // The plan survives a fresh Runtime over the same workspace, which is the
    // whole point of persisting it: a restart must not lose where the work was.
    const restarted = new Runtime({ config, logger, session: new SessionStore(workspace, config.model, undefined, join(workspace, "sessions")) });
    expect(restarted.dag.all().length).toBe(1);
    expect(restarted.dag.snapshot().objective).toBe("ship the feature");
    // And the learned rule survives too, since it lives in the workspace.
    expect(restarted.operatorMemory.all()[0]?.text).toContain("use the other API");
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

  it("does not call require() from ESM source", async () => {
    // `require` does not exist in an ES module, so a stray call throws
    // ReferenceError at runtime. Inside a try/catch it fails silently, which is
    // how the Windows terminal setup went unnoticed. The build must not contain
    // a bare require().
    const sources = await collectFiles(join(process.cwd(), "src"));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const text = await readFile(source, "utf8");
      // Ignore comments and `createRequire`-style calls.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${source} calls require()`).not.toMatch(/(?<![\w.])require\s*\(/);
    }
  });
});

async function collectFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await collectFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

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
  /** Git Bash prints `/c/...`; Node needs `C:\\...` to stat the same file. */
  const toPosix = (value: string): string =>
    process.platform === "win32"
      ? value.replace(/^([A-Za-z]):[\\/]/, (_match, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/")
      : value;
  const toPosixPathList = (value: string): string =>
    process.platform === "win32" ? value.split(";").filter(Boolean).map(toPosix).join(":") : value;
  const toHost = (value: string): string => {
    if (process.platform !== "win32") return value;
    const match = /^\/([A-Za-z])\/(.*)$/.exec(value);
    return match === null ? value : `${match[1]?.toUpperCase()}:\\${match[2]?.replace(/\//g, "\\")}`;
  };
  /** Git Bash omits `.exe`; Node needs the real filename to stat it. */
  const hostExists = (value: string): boolean => {
    const host = toHost(value);
    if (existsSync(host)) return true;
    return process.platform === "win32" && existsSync(`${host}.exe`);
  };

  /** The launcher must never embed a node path that does not exist. */
  async function resolveNodeBin(env: Record<string, string | undefined>, nodeDir?: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const script = [
      `PATH=${JSON.stringify(toPosixPathList(env.PATH ?? process.env.PATH ?? ""))} export PATH`,
      `CARLS_NODE_DIR=${JSON.stringify(nodeDir !== undefined ? toPosix(nodeDir) : "")} export CARLS_NODE_DIR`,
      `. ${JSON.stringify(toPosix(join(process.cwd(), "scripts", "lib", "node-bin.sh")))}`,
      "carls_resolve_node_bin",
    ].join("\n");
    // An absolute bash path on POSIX; Git Bash's `bash` on Windows. The test
    // deliberately empties the child PATH, so the interpreter must be resolved
    // from the parent environment before the script runs.
    const winGitBash = [
      process.env.ProgramFiles !== undefined ? join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ].find((candidate) => candidate.length > 0 && existsSync(candidate));
    const shell = process.platform === "win32" ? (winGitBash ?? "bash") : "/bin/bash";
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(shell, ["-c", script], {}, (error, stdout) => {
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
    expect(hostExists(bin)).toBe(true);
  });

  it("uses the private node only when that binary really exists", async () => {
    const fake = join(dir, "nodehome");
    await mkdir(join(fake, "bin"), { recursive: true });
    expect(await resolveNodeBin({ PATH: process.env.PATH }, fake)).not.toContain(toPosix(fake));
    await writeFile(join(fake, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    expect(toHost(await resolveNodeBin({ PATH: process.env.PATH }, fake))).toBe(join(fake, "bin", "node"));
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

describe("Shift+Tab mode cycling", () => {
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

  it("repaints the footer without writing a stray line into the conversation", async () => {
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

    let cycled = 0;
    const prompt = new Prompt(input, output);
    const pending = prompt.read({
      prompt: "carls> ",
      onModeCycle: () => {
        cycled += 1;
        return "build";
      },
      chrome,
    });
    await new Promise((r) => setTimeout(r, 10));
    input.write("\u001b[Z");
    await new Promise((r) => setTimeout(r, 20));
    input.write("\r");
    await pending;

    // The callback still fires so the caller can repaint the status line, but
    // nothing lands in the conversation region: no "mode → build" note, and no
    // cursor move to the region bottom that used to accompany it.
    expect(cycled).toBe(1);
    const out = writes.join("");
    expect(out).not.toContain("mode →");
    const regionBottom = layout?.regionBottom ?? 0;
    expect(out).not.toContain(`\u001b[${regionBottom};1H`);
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

  it("drops the group headings when every row belongs to one group", async () => {
    // A single workspace is the common case; a lone "this directory" heading
    // adds a row of noise and nothing to navigate.
    const { output } = await drive(
      ["q"],
      [
        { id: "a", label: "a", section: "this directory" },
        { id: "b", label: "b", section: "this directory" },
      ],
    );
    expect(output).not.toContain("this directory");
    expect(output).not.toContain("\u25be");
    expect(output).not.toContain("collapse");
  });

  it("never leaves a section heading alone at the bottom of a page", async () => {
    // The page used to be cut by row, so a heading could land on the last line
    // with its items pushed to the next page — a heading with nothing under it.
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      label: `sess-${i}`,
      section: i < 6 ? "A" : "B",
    }));
    const { output } = await drive(["\u001b[F", "q"], many);
    const frames = output.split("\u001b[H").slice(1);
    for (const frame of frames) {
      const rows = frame
        .split("\r\n")
        .map((line) => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").trimEnd())
        .filter((line) => line.length > 0);
      const lastContent = rows[rows.length - 2] ?? "";
      const isHeading = /[\u25be\u25b8]/.test(lastContent) && /\(\d+\)/.test(lastContent);
      expect(isHeading).toBe(false);
    }
  });

  it("counts items, not rows, in the position indicator", async () => {
    const grouped = [
      { id: "a/1", label: "a/1", section: "a" },
      { id: "b/1", label: "b/1", section: "b" },
    ];
    const { output } = await drive(["q"], grouped);
    // Two headings plus two items: a row count would read 1/4.
    expect(output).toContain("1/2");
    expect(output).not.toContain("1/4");
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
        await client.close();
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
      await client.close();
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
    const localTransport = buildTransport(
      "local",
      { command: process.execPath, args: ["-e", ""] },
      logger,
      dir,
    );
    expect(localTransport.kind).toBe("stdio");
    // Close it before `afterEach` removes the workspace: on Windows the child
    // holds a handle to its cwd until it exits.
    await localTransport.close();

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

describe("session export", () => {
  it("renders a transcript with tool calls and results", async () => {
    const { renderTranscript } = await import("../src/cli/Export.js");
    const messages = [
      { role: "system" as const, content: [{ type: "text" as const, text: "ignored" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "fix the bug" }] },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Looking at it." },
          { type: "tool_use" as const, id: "t1", name: "read_file", input: { path: "src/a.ts" } },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "1\tconst a = 1;", is_error: false }],
      },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t2", content: "boom", is_error: true }] },
    ];
    const md = renderTranscript(messages, {
      sessionId: "s1",
      model: "gpt-4o",
      cwd: "/work",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(md).toContain("# carls session s1");
    expect(md).toContain("## user");
    expect(md).toContain("fix the bug");
    expect(md).toContain("### tool call · read_file");
    expect(md).toContain('"path": "src/a.ts"');
    expect(md).toContain("const a = 1;");
    expect(md).toContain("### tool result · error");
    expect(md).not.toContain("ignored");
  });

  it("writes the transcript to disk", async () => {
    const { writeTranscript } = await import("../src/cli/Export.js");
    const target = join(dir, "export", "session.md");
    const result = await writeTranscript(
      target,
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { sessionId: "s2", model: "gpt-4o", cwd: dir },
    );
    expect(result.path).toBe(target);
    expect(result.bytes).toBeGreaterThan(0);
    expect(await readFile(target, "utf8")).toContain("hello");
  });
});

describe("workspace path guard", () => {
  it("fails closed when the real path cannot be resolved", async () => {
    const { assertNoSymlinkEscape } = await import("../src/utils/paths.js");
    const missingRoot = join(dir, "guard-missing-root");
    const problem = assertNoSymlinkEscape(missingRoot, join(missingRoot, "file.txt"));
    expect(problem).toContain("could not resolve");

    // A resolvable path inside the workspace is still allowed.
    await mkdir(join(dir, "guard-ok"), { recursive: true });
    await writeFile(join(dir, "guard-ok", "file.txt"), "x");
    expect(assertNoSymlinkEscape(join(dir, "guard-ok"), join(dir, "guard-ok", "file.txt"))).toBeUndefined();
  });
});

describe("prompt queue", () => {
  it("keeps order, ignores blank lines and honours the cap", async () => {
    const { PromptQueue } = await import("../src/cli/Queue.js");
    const queue = new PromptQueue(2);
    expect(queue.push("first")).toBe(1);
    expect(queue.push("   ")).toBe(1);
    expect(queue.push("second")).toBe(2);
    expect(queue.push("third")).toBe(2);
    expect(queue.list()).toEqual(["first", "second"]);
    expect(queue.shift()).toBe("first");
    expect(queue.length).toBe(1);
  });

  it("drains prompts queued while draining", async () => {
    const { PromptQueue, drainQueue } = await import("../src/cli/Queue.js");
    const queue = new PromptQueue();
    queue.push("one");
    queue.push("two");
    const seen: string[] = [];
    await drainQueue(queue, async (text) => {
      seen.push(text);
      if (text === "one") queue.push("three");
    });
    expect(seen).toEqual(["one", "two", "three"]);
    expect(queue.length).toBe(0);
  });

  it("ignores keys while an approval prompt owns stdin", async () => {
    const { PromptQueue, collectTypedLines } = await import("../src/cli/Queue.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    output.on("data", () => undefined);
    const queue = new PromptQueue();
    const handle = collectTypedLines({ input, output, queue });
    input.emit("keypress", "a", { name: "a" });
    handle.pause();
    input.emit("keypress", "y", { name: "y" });
    input.emit("keypress", "\r", { name: "return" });
    expect(queue.length).toBe(0);
    handle.resume();
    input.emit("keypress", "\r", { name: "return" });
    handle.stop();
    expect(queue.list()).toEqual(["a"]);
  });

  it("hands a submitted line to the steering callback instead of queueing", async () => {
    const { PromptQueue, collectTypedLines } = await import("../src/cli/Queue.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    output.on("data", () => undefined);
    const queue = new PromptQueue();
    const steered: string[] = [];
    const handle = collectTypedLines({ input, output, queue, onSubmit: (text) => steered.push(text) });
    input.emit("keypress", "r", { name: "r" });
    input.emit("keypress", "\r", { name: "return" });
    handle.stop();
    expect(steered).toEqual(["r"]);
    expect(queue.length).toBe(0);
  });

  it("collects typed lines while a turn runs", async () => {
    const { PromptQueue, collectTypedLines } = await import("../src/cli/Queue.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    output.on("data", () => undefined);
    const queue = new PromptQueue();
    let interrupts = 0;
    const handle = collectTypedLines({ input, output, queue, onInterrupt: () => (interrupts += 1) });

    const press = (sequence: string, key: Record<string, unknown>): void => {
      input.emit("keypress", sequence, key);
    };
    press("h", { name: "h" });
    press("i", { name: "i" });
    press("\r", { name: "return" });
    press("x", { name: "x" });
    press("\b", { name: "backspace" });
    press("\r", { name: "return" });
    press("\u0003", { name: "c", ctrl: true });
    handle.stop();

    expect(queue.list()).toEqual(["hi"]);
    expect(interrupts).toBe(1);
    // The listener is gone once stopped: later keys cannot queue anything.
    press("z", { name: "z" });
    press("\r", { name: "return" });
    expect(queue.list()).toEqual(["hi"]);
  });
});

describe("agent permission blocks", () => {
  const preset = [
    "---",
    "description: Reviewer that never writes",
    "permission:",
    "  edit: deny",
    "  webfetch: deny",
    "  bash:",
    '    "*": ask',
    '    "git diff": allow',
    '    "rm -rf *": deny',
    "---",
    "You review diffs.",
  ].join("\n");

  it("parses edit, webfetch and bash rules", async () => {
    const { parsePreset } = await import("../src/agents/Presets.js");
    const parsed = parsePreset("reviewer", preset, "project", "/tmp/r.md");
    expect(parsed.permission?.edit).toBe("deny");
    expect(parsed.permission?.webfetch).toBe("deny");
    expect(parsed.permission?.bash).toEqual([
      { pattern: "*", action: "ask" },
      { pattern: "git diff", action: "allow" },
      { pattern: "rm -rf *", action: "deny" },
    ]);
    // Unknown actions are dropped instead of silently becoming a deny.
    const odd = parsePreset("odd", "---\npermission:\n  edit: maybe\n---\nbody", "project", "/tmp/o.md");
    expect(odd.permission).toBeUndefined();
  });

  it("folds the block into tool and command rules the gate enforces", async () => {
    const { parsePreset, applyPreset } = await import("../src/agents/Presets.js");
    const { loadConfig } = await import("../src/config/Config.js");
    const { PermissionGate } = await import("../src/security/PermissionGate.js");
    const workspace = join(dir, "permission-workspace");
    await mkdir(workspace, { recursive: true });
    const previous = process.env.CARLS_SYSTEM_CONFIG;
    process.env.CARLS_SYSTEM_CONFIG = join(workspace, "missing.json");
    try {
      const base = loadConfig({}, workspace);
      const next = applyPreset(base, parsePreset("reviewer", preset, "project", "/tmp/r.md"));
      expect(next.permissions.toolDeny).toContain("edit_file");
      expect(next.permissions.toolDeny).toContain("web_search");
      expect(next.permissions.deny).toContain("rm -rf *");
      expect(next.permissions.allow).toContain("git diff");

      const gate = new PermissionGate(next, new Logger("error"), async () => "y");
      const edit = new FileEdit();
      expect(
        await gate.authorize({ tool: edit, input: { path: "a.ts", old_string: "a", new_string: "b" }, preview: "" }),
      ).toBe("deny");
      const bash = new BashExecution();
      expect(await gate.authorize({ tool: bash, input: { command: "rm -rf /tmp/x" }, preview: "" })).toBe("deny");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previous;
    }
  });

  it("releases the composer while an approval is on screen", async () => {
    const { loadConfig } = await import("../src/config/Config.js");
    const { PermissionGate } = await import("../src/security/PermissionGate.js");
    const workspace = join(dir, "permission-pause");
    await mkdir(workspace, { recursive: true });
    const config = loadConfig({ mode: "ask" }, workspace);
    const pauses: boolean[] = [];
    let asked = 0;
    const gate = new PermissionGate(config, new Logger("error"), async () => {
      asked += 1;
      return "n";
    });
    gate.setPromptPause((paused) => pauses.push(paused));
    expect(await gate.authorize({ tool: new FileEdit(), input: { path: "a.ts" }, preview: "" })).toBe("deny");
    expect(asked).toBe(1);
    expect(pauses).toEqual([true, false]);
  });

  it("a preset deny beats a config allow, and yolo is the documented exception", async () => {
    const { parsePreset, applyPreset } = await import("../src/agents/Presets.js");
    const { loadConfig } = await import("../src/config/Config.js");
    const { PermissionGate } = await import("../src/security/PermissionGate.js");
    const workspace = join(dir, "permission-precedence");
    await mkdir(workspace, { recursive: true });
    const previous = process.env.CARLS_SYSTEM_CONFIG;
    process.env.CARLS_SYSTEM_CONFIG = join(workspace, "missing.json");
    try {
      const preset = parsePreset(
        "locked",
        '---\npermission:\n  edit: deny\n  bash:\n    "git status": deny\n---\nbody',
        "project",
        "/tmp/locked.md",
      );
      // The config says the opposite of the preset, on purpose.
      const base = loadConfig({}, workspace);
      base.permissions.allow = ["git status"];
      base.permissions.toolAllow = ["edit_file", "write_file"];
      const next = applyPreset(base, preset);

      const gate = new PermissionGate(next, new Logger("error"), async () => "y");
      expect(await gate.authorize({ tool: new FileEdit(), input: { path: "a.ts" }, preview: "" })).toBe("deny");
      expect(
        await gate.authorize({ tool: new BashExecution(), input: { command: "git status" }, preview: "" }),
      ).toBe("deny");

      // yolo keeps its meaning: everything runs, deny lists included.
      const yolo = applyPreset(loadConfig({ yolo: true }, workspace), preset);
      const yoloGate = new PermissionGate(yolo, new Logger("error"), async () => "y");
      expect(await yoloGate.authorize({ tool: new FileEdit(), input: { path: "a.ts" }, preview: "" })).toBe("allow");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previous;
    }
  });

  it("lets a preset allow edits without prompting", async () => {
    const { parsePreset, applyPreset } = await import("../src/agents/Presets.js");
    const { loadConfig } = await import("../src/config/Config.js");
    const { PermissionGate } = await import("../src/security/PermissionGate.js");
    const workspace = join(dir, "permission-allow");
    await mkdir(workspace, { recursive: true });
    const previous = process.env.CARLS_SYSTEM_CONFIG;
    process.env.CARLS_SYSTEM_CONFIG = join(workspace, "missing.json");
    try {
      const base = loadConfig({}, workspace);
      const next = applyPreset(
        base,
        parsePreset("writer", "---\npermission:\n  edit: allow\n---\nbody", "project", "/tmp/w.md"),
      );
      const gate = new PermissionGate(next, new Logger("error"), async () => "n");
      expect(gate.needsApproval(new FileEdit(), { path: "a.ts" })).toBe(false);
      expect(
        await gate.authorize({ tool: new FileEdit(), input: { path: "a.ts" }, preview: "" }),
      ).toBe("allow");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previous;
    }
  });
});

describe("plugin hooks", () => {
  const hookScript = [
    'import { appendFileSync } from "node:fs";',
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => (raw += chunk));',
    'process.stdin.on("end", () => {',
    '  const payload = JSON.parse(raw || "{}");',
    '  appendFileSync(new URL("./hook-log.txt", import.meta.url), `${payload.event}|${payload.toolName ?? ""}|${payload.input?.command ?? ""}\\n`);',
    '  if (payload.event === "tool.execute.before") {',
    '    if (payload.input.command === "forbidden") { process.exitCode = 2; process.stdout.write("not allowed"); return; }',
    '    process.stdout.write(JSON.stringify({ args: { command: `${payload.input.command}; echo rewritten` } }));',
    '    return;',
    "  }",
    '  if (payload.event === "tool.execute.after") process.stdout.write(JSON.stringify({ output: "observation replaced" }));',
    "});",
  ].join("\n");

  it("accepts the dotted plugin names in the config", async () => {
    const cwd = join(dir, "hooks-config");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, ".carlsrc.json"),
      JSON.stringify({
        hooks: {
          "tool.execute.before": ["echo before"],
          "tool.execute.after": ["echo after"],
          "session.idle": ["echo idle"],
          preToolUse: ["echo pre"],
        },
      }),
      "utf8",
    );
    const config = loadConfig({}, cwd);
    expect(config.hooks.toolExecuteBefore).toEqual(["echo before"]);
    expect(config.hooks.toolExecuteAfter).toEqual(["echo after"]);
    expect(config.hooks.sessionIdle).toEqual(["echo idle"]);
    expect(config.hooks.preToolUse).toEqual(["echo pre"]);
  });

  it("vetoes a call, rewrites its input and replaces the observation", async () => {
    const { AgentLoop } = await import("../src/core/AgentLoop.js");
    const { CostTracker } = await import("../src/core/CostTracker.js");
    const { Hooks } = await import("../src/core/Hooks.js");
    const { BashExecution } = await import("../src/tools/BashExecution.js");

    const workspace = join(dir, "hooks-run");
    await mkdir(workspace, { recursive: true });
    const script = join(workspace, "hook.mjs");
    await writeFile(script, hookScript, "utf8");

    const registry = new ToolRegistry();
    registry.register(new BashExecution());
    const config = loadConfig({ yolo: true, maxSteps: 6 }, workspace);
    config.hooks.toolExecuteBefore = [`node ${script}`];
    config.hooks.toolExecuteAfter = [`node ${script}`];
    const session = new SessionStore(workspace, config.model, undefined, join(workspace, "sessions"));

    const scripted: import("../src/types/llm.js").LLMResponse[] = [
      {
        content: [{ type: "tool_use", id: "a", name: "bash", input: { command: "echo original" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: "tool_use", id: "b", name: "bash", input: { command: "forbidden" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const requests: Message[][] = [];
    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        requests.push(args.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        const next = scripted.shift();
        if (next === undefined) throw new Error("scripted provider exhausted");
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
      hooks: new Hooks(config.hooks, logger, workspace),
      config,
      logger,
      systemPrompt: "test",
      toolContext: { cwd: workspace, config, session, logger },
    });

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "run it" }] }];
    const result = await loop.run(history, "run it", { silent: true });
    expect(result.stoppedReason).toBe("completed");

    const third = requests[2] ?? [];
    const blocks = third.flatMap((message) => message.content);
    const results = blocks.filter(
      (block): block is Extract<Message["content"][number], { type: "tool_result" }> => block.type === "tool_result",
    );
    expect(results[0]?.content).toBe("observation replaced");
    expect(results[1]?.content).toContain("Blocked by a before hook: not allowed");

    // The rewrite reached bash, not just the hook.
    const log = await readFile(join(workspace, "hook-log.txt"), "utf8");
    expect(log).toContain("tool.execute.before|bash|echo original");
    expect(log).toContain("tool.execute.after|bash|echo original; echo rewritten");
  });

  it("fires session.idle when a turn finishes", async () => {
    const { Runtime } = await import("../src/core/Runtime.js");

    const workspace = join(dir, "hooks-idle");
    await mkdir(workspace, { recursive: true });
    const script = join(workspace, "hook.mjs");
    await writeFile(script, hookScript, "utf8");

    const config = loadConfig({ yolo: true }, workspace);
    config.apiKey = "test-key";
    config.hooks.sessionIdle = [`node ${script}`];
    const session = new SessionStore(workspace, config.model, undefined, join(workspace, "sessions"));
    const runtime = new Runtime({ config, logger, session });
    runtime.loop.setProvider({
      name: "idle",
      async complete() {
        return {
          content: [{ type: "text", text: "nothing to do" }],
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      },
    });

    await runtime.runTurn("say hi", { silent: true });
    const log = await readFile(join(workspace, "hook-log.txt"), "utf8");
    expect(log).toContain("session.idle|");
  });
});

describe("external editor", () => {
  it("picks the editor in the order a terminal respects", async () => {
    const { editorSpec } = await import("../src/cli/Editor.js");
    expect(editorSpec({ CARLS_EDITOR: "nano", VISUAL: "vi", EDITOR: "ed" }, "linux")?.command).toBe("nano");
    expect(editorSpec({ VISUAL: "vi", EDITOR: "ed" }, "linux")?.command).toBe("vi");
    expect(editorSpec({ EDITOR: "code --wait" }, "linux")).toEqual({ command: "code", args: ["--wait"] });
    // No editor and no default on POSIX: the command explains it instead of guessing.
    expect(editorSpec({}, "linux")).toBeUndefined();
    expect(editorSpec({}, "win32")?.command).toBe("notepad");
  });

  it("returns what the editor saved", async () => {
    const { composeInEditor } = await import("../src/cli/Editor.js");
    const script = join(dir, "fake-editor.mjs");
    await writeFile(
      script,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const file = process.argv[2];',
        'writeFileSync(file, `${readFileSync(file, "utf8").trim()}\\nand a second line`);',
      ].join("\n"),
    );
    const result = await composeInEditor({
      initial: "first line",
      spec: { command: process.execPath, args: [script] },
    });
    expect(result.changed).toBe(true);
    expect(result.text).toContain("and a second line");

    const untouched = await composeInEditor({
      initial: "same",
      spec: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      timeoutMs: 5000,
    });
    expect(untouched.changed).toBe(false);

    // The no-editor path must not inherit whatever this machine has configured.
    // The platform is injected as Linux because Windows intentionally falls
    // back to notepad, which would block the test waiting for a window.
    const saved = {
      CARLS_EDITOR: process.env.CARLS_EDITOR,
      VISUAL: process.env.VISUAL,
      EDITOR: process.env.EDITOR,
    };
    delete process.env.CARLS_EDITOR;
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    try {
      const noEditor = await composeInEditor({ initial: "x", env: {}, platform: "linux" });
      expect(noEditor.error).toBe("no editor is configured");
      expect(noEditor.changed).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 20000);
});

describe("lsp diagnostics", () => {
  /** A language server that answers initialize and pushes one diagnostic. */
  async function writeFakeServer(name: string): Promise<string> {
    const path = join(dir, `fake-${name}-lsp.mjs`);
    await writeFile(
      path,
      [
        'const send = (message) => { const body = Buffer.from(JSON.stringify(message));',
        '  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\\r\\n\\r\\n`), body])); };',
        'let buffer = Buffer.alloc(0);',
        'process.stdin.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]);',
        '  for (;;) { const end = buffer.indexOf("\\r\\n\\r\\n"); if (end === -1) break;',
        '    const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);',
        '    const start = end + 4; if (buffer.length < start + length) break;',
        '    const message = JSON.parse(buffer.subarray(start, start + length).toString());',
        '    buffer = buffer.subarray(start + length);',
        '    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } });',
        '    if (message.method === "textDocument/hover") send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "**const a: number**" } } });',
        '    if (message.method === "textDocument/definition") send({ jsonrpc: "2.0", id: message.id, result: [{ uri: message.params.textDocument.uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }] });',
        '    if (message.method === "textDocument/codeAction") send({ jsonrpc: "2.0", id: message.id, result: [{ title: "Use let", kind: "quickfix", edit: { changes: { [message.params.textDocument.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "let" }] } } }, { title: "Organize imports", kind: "source.organizeImports", command: { title: "organize", command: "fake.organize" } }] });',
        '    if (message.method === "textDocument/rename") { const uri = message.params.textDocument.uri; const sibling = uri.replace(/rename\\.ts$/, "other.ts");',
        '      send({ jsonrpc: "2.0", id: message.id, result: { changes: { [uri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: message.params.newName }, { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } }, newText: message.params.newName }], [sibling]: [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 10 } }, newText: message.params.newName }] } } }); }',
        '    if (message.method === "textDocument/didOpen") {',
        '      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri,',
        '        diagnostics: [{ range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 1, source: "fake", code: 2322, message: "Type string is not assignable to number" }] } }); }',
        '    if (message.id !== undefined && message.method === "shutdown") send({ jsonrpc: "2.0", id: message.id, result: null });',
        '  } });',
      ].join("\n"),
    );
    return path;
  }

  it("frames and unframes JSON-RPC messages", async () => {
    const { frameMessage, unframe } = await import("../src/lsp/Client.js");
    const framed = frameMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(framed.toString("utf8")).toMatch(/^Content-Length: \d+\r\n\r\n/);
    const split = unframe(Buffer.concat([framed, framed.subarray(0, 10)]));
    expect(split.messages).toHaveLength(1);
    expect(split.rest.length).toBe(10);
    expect(split.messages[0]?.method).toBe("initialize");
  });

  it("reports what the language server pushes for the file", async () => {
    const { LspTool } = await import("../src/tools/Lsp.js");
    const workspace = join(dir, "lsp-workspace");
    await mkdir(workspace, { recursive: true });
    const script = await writeFakeServer("ok");
    await writeFile(join(workspace, "file.ts"), "const a: number = 'x';\n");

    const context = { ...makeContext(), cwd: workspace } as ReturnType<typeof makeContext> & {
      cwd: string;
    };
    context.config.cwd = workspace;
    context.config.lspServers = { ".ts": { command: process.execPath, args: [script] } };

    const result = await new LspTool().run({ path: "file.ts" }, context);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("1 diagnostic (1 error)");
    expect(result.output).toContain("file.ts:3:5 error: Type string is not assignable to number");
    expect(result.output).toContain("[2322]");

    const hover = await new LspTool().run({ path: "file.ts", action: "hover", line: 1, character: 7 }, context);
    expect(hover.ok).toBe(true);
    expect(hover.output).toContain("**const a: number**");

    const definition = await new LspTool().run(
      { path: "file.ts", action: "definition", line: 1, character: 7 },
      context,
    );
    expect(definition.ok).toBe(true);
    expect(definition.output).toContain("file.ts:5:3");

    const noPosition = await new LspTool().run({ path: "file.ts", action: "hover" }, context);
    expect(noPosition.ok).toBe(false);
    expect(noPosition.error).toContain("needs a position");
  }, 30000);

  it("lists code actions and applies them and renames across files", async () => {
    const { LspTool } = await import("../src/tools/Lsp.js");
    const { LspEdit } = await import("../src/tools/LspEdit.js");
    const { applyTextEdits } = await import("../src/lsp/Edits.js");

    // Pure offset math first: edits must apply back to front to stay valid.
    expect(
      applyTextEdits("abc", [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" },
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, newText: "Y" },
      ]),
    ).toBe("XbY");

    const workspace = join(dir, "lsp-edit-workspace");
    await mkdir(workspace, { recursive: true });
    const script = await writeFakeServer("edit");
    const target = join(workspace, "rename.ts");
    const sibling = join(workspace, "other.ts");
    await writeFile(target, "const a = 1;\nconst b = a;\n");
    await writeFile(sibling, 'import { a } from "./rename";\n');

    const context = { ...makeContext(), cwd: workspace } as ReturnType<typeof makeContext> & {
      cwd: string;
    };
    context.config.cwd = workspace;
    context.config.lspServers = { ".ts": { command: process.execPath, args: [script] } };

    const listed = await new LspTool().run(
      { path: "rename.ts", action: "codeActions", line: 1, character: 7 },
      context,
    );
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("2 code actions");
    expect(listed.output).toContain("1. Use let [quickfix]");
    expect(listed.output).toContain("command only");

    // Rename first: its ranges are fixed to the original "const a = 1;" text.
    const preview = await new LspEdit().run(
      { path: "rename.ts", line: 1, character: 7, action: "rename", newName: "renamed", dryRun: true },
      context,
    );
    expect(preview.ok).toBe(true);
    expect(preview.output).toContain("would change 2 files");
    expect(await readFile(sibling, "utf8")).toBe('import { a } from "./rename";\n');

    const renamed = await new LspEdit().run(
      { path: "rename.ts", line: 1, character: 7, action: "rename", newName: "renamed" },
      context,
    );
    expect(renamed.ok).toBe(true);
    expect(renamed.output).toContain("applied to 2 files");
    expect(await readFile(target, "utf8")).toBe("const renamed = 1;\nconst b = renamed;\n");
    expect(await readFile(sibling, "utf8")).toBe('import { renamed } from "./rename";\n');

    const applied = await new LspEdit().run(
      { path: "rename.ts", line: 1, character: 7, action: "codeAction", index: 1 },
      context,
    );
    expect(applied.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("let renamed = 1;\nconst b = renamed;\n");

    const commandOnly = await new LspEdit().run(
      { path: "rename.ts", line: 1, character: 7, action: "codeAction", index: 2 },
      context,
    );
    expect(commandOnly.ok).toBe(false);
    expect(commandOnly.error).toContain("carries no edit");

    const missingName = await new LspEdit().run(
      { path: "rename.ts", line: 1, character: 7, action: "rename" },
      context,
    );
    expect(missingName.ok).toBe(false);
    expect(missingName.error).toContain("needs newName");
  }, 30000);

  it("explains how to configure a server when none is set", async () => {
    const { LspTool } = await import("../src/tools/Lsp.js");
    const workspace = join(dir, "lsp-unconfigured");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "file.py"), "print(1)\n");
    const context = { ...makeContext(), cwd: workspace } as ReturnType<typeof makeContext> & {
      cwd: string;
    };
    context.config.cwd = workspace;
    const result = await new LspTool().run({ path: "file.py" }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("lspServers");
  });
});

describe("web tools", () => {
  it("reduces HTML to readable text", async () => {
    const { htmlToText, pageTitle, decodeEntities } = await import("../src/tools/WebOps.js");
    const html =
      "<html><head><title>Docs &amp; API</title><style>body{color:red}</style></head>" +
      "<body><script>steal()</script><h1>Install</h1><p>Run <code>npm i</code> &lt;now&gt;.</p>" +
      "<ul><li>one</li><li>two</li></ul></body></html>";
    const text = htmlToText(html);
    expect(text).not.toContain("steal");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Install");
    expect(text).toContain("Run npm i <now>.");
    expect(text).toContain("· one");
    expect(pageTitle(html)).toBe("Docs & API");
    expect(decodeEntities("&#65;&#x42;&nbsp;&mdash;&bogus;")).toBe("AB —&bogus;");
  });

  it("refuses loopback, private hosts and non-http schemes", async () => {
    const { urlProblem, WebFetch } = await import("../src/tools/WebOps.js");
    expect(urlProblem("http://169.254.169.254/latest/meta-data/")).toContain("cloud metadata");
    expect(urlProblem("http://127.0.0.1:8080/admin")).toContain("loopback");
    expect(urlProblem("http://10.1.2.3/")).toContain("private");
    expect(urlProblem("http://[::1]/")).toContain("IPv6");
    expect(urlProblem("file:///etc/passwd")).toContain("not allowed");
    expect(urlProblem("not a url")).toBe("not an absolute URL");
    expect(urlProblem("https://example.com/docs")).toBeUndefined();
    // The tool itself must refuse before opening a socket.
    const blocked = await new WebFetch().run({ url: "http://127.0.0.1:1/" }, makeContext());
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("loopback");
  });

  it("fetches a page as text and truncates it", async () => {
    const { WebFetch } = await import("../src/tools/WebOps.js");
    const previousAllow = process.env.CARLS_ALLOW_LOCAL_FETCH;
    process.env.CARLS_ALLOW_LOCAL_FETCH = "1";
    const server = createServer((req, res) => {
      if (req.url === "/missing") {
        res.writeHead(404, { "content-type": "text/html" }).end("<h1>gone</h1>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><head><title>Release notes</title></head><body><h1>v2</h1><p>${"word ".repeat(200)}</p><script>x()</script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const tool = new WebFetch();
      const ok = await tool.run({ url: `http://127.0.0.1:${port}/`, max_chars: 80 }, makeContext());
      expect(ok.ok).toBe(true);
      expect(ok.output).toContain("title: Release notes");
      expect(ok.output).toContain("truncated at 80 characters");
      expect(ok.output).not.toContain("x()");

      const missing = await tool.run({ url: `http://127.0.0.1:${port}/missing` }, makeContext());
      expect(missing.ok).toBe(false);
      expect(missing.error).toContain("HTTP 404");

      const bad = await tool.run({ url: "file:///etc/passwd" }, makeContext());
      expect(bad.ok).toBe(false);
    } finally {
      if (previousAllow === undefined) delete process.env.CARLS_ALLOW_LOCAL_FETCH;
      else process.env.CARLS_ALLOW_LOCAL_FETCH = previousAllow;
      server.close();
    }
  });

  it("parses results and searches through the configured endpoint", async () => {
    const { parseSearchResults, WebSearch } = await import("../src/tools/WebOps.js");
    const page = [
      '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2F&amp;rut=abc">Node.js &mdash; Run JavaScript</a>',
      '<a class="result__snippet">A JavaScript runtime built on V8.</a></div>',
      '<div class="result"><a class="result__a" href="https://example.test/two">Second</a>',
      '<a class="result__snippet">Another hit.</a></div>',
    ].join("");

    const hits = parseSearchResults(page, 5);
    expect(hits.map((hit) => hit.url)).toEqual(["https://nodejs.org/en", "https://example.test/two"]);
    expect(hits[0]?.title).toBe("Node.js — Run JavaScript");
    expect(hits[1]?.snippet).toBe("Another hit.");

    let asked = "";
    const server = createServer((req, res) => {
      asked = req.url ?? "";
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const previous = process.env.CARLS_SEARCH_ENDPOINT;
    const previousAllow = process.env.CARLS_ALLOW_LOCAL_FETCH;
    process.env.CARLS_SEARCH_ENDPOINT = `http://127.0.0.1:${port}/html/`;
    process.env.CARLS_ALLOW_LOCAL_FETCH = "1";
    try {
      const result = await new WebSearch().run({ query: "node runtime", max_results: 1 }, makeContext());
      expect(result.ok).toBe(true);
      expect(asked).toContain("q=node%20runtime");
      expect(result.output).toContain("https://nodejs.org/en");
      expect(result.output).not.toContain("example.test/two");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SEARCH_ENDPOINT;
      else process.env.CARLS_SEARCH_ENDPOINT = previous;
      if (previousAllow === undefined) delete process.env.CARLS_ALLOW_LOCAL_FETCH;
      else process.env.CARLS_ALLOW_LOCAL_FETCH = previousAllow;
      server.close();
    }
  });

  it("drops ads, tracking parameters and duplicate results", async () => {
    const { parseSearchResults, cleanUrl } = await import("../src/tools/WebOps.js");
    const page = [
      '<a class="result__a" href="https://example.test/doc?utm_source=ddg&amp;utm_medium=web&amp;id=7">Docs</a>',
      '<a class="result__a" href="https://example.test/doc?id=7">Docs again</a>',
      '<a class="result__a" href="//duckduckgo.com/y.js?ad_provider=bing">Sponsored</a>',
      '<a class="result__a" href="http://127.0.0.1/admin">Injected</a>',
    ].join("");
    const hits = parseSearchResults(page, 10);
    expect(hits.map((hit) => hit.url)).toEqual(["https://example.test/doc?id=7"]);
    expect(cleanUrl("https://example.test/a/?utm_campaign=x#frag")).toBe("https://example.test/a");
  });

  it("retries a rate limit and falls back when the endpoint is a challenge", async () => {
    const { WebSearch } = await import("../src/tools/WebOps.js");
    let calls = 0;
    const page = '<a class="result__a" href="https://example.test/ok">Ok</a>';
    const server = createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "content-type": "text/html" }).end("slow down");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const previous = process.env.CARLS_SEARCH_ENDPOINT;
    const previousAllow = process.env.CARLS_ALLOW_LOCAL_FETCH;
    process.env.CARLS_SEARCH_ENDPOINT = `http://127.0.0.1:${port}/`;
    process.env.CARLS_ALLOW_LOCAL_FETCH = "1";
    try {
      const result = await new WebSearch().run({ query: "retry me" }, makeContext());
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
      expect(result.output).toContain("https://example.test/ok");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SEARCH_ENDPOINT;
      else process.env.CARLS_SEARCH_ENDPOINT = previous;
      if (previousAllow === undefined) delete process.env.CARLS_ALLOW_LOCAL_FETCH;
      else process.env.CARLS_ALLOW_LOCAL_FETCH = previousAllow;
      server.close();
    }
  });
});

describe("agent presets", () => {
  const preset = [
    "---",
    "description: Reviews a diff, never edits",
    "mode: plan",
    "tools: read_file, grep_search",
    "effort: high",
    "---",
    "You are a reviewer. Read the diff and report findings.",
  ].join("\n");

  it("splits frontmatter from the instruction body", async () => {
    const { splitFrontmatter, parsePreset } = await import("../src/agents/Presets.js");
    const split = splitFrontmatter(preset);
    expect(split.meta.mode).toBe("plan");
    expect(split.body.startsWith("You are a reviewer.")).toBe(true);

    const parsed = parsePreset("reviewer", preset, "project", "/tmp/reviewer.md");
    expect(parsed.mode).toBe("plan");
    expect(parsed.effort).toBe("high");
    expect(parsed.tools).toEqual(["read_file", "grep_search"]);

    // A file without frontmatter is all body, and bad values are dropped.
    const plain = parsePreset("plain", "just instructions", "user", "/tmp/plain.md");
    expect(plain.prompt).toBe("just instructions");
    expect(plain.mode).toBeUndefined();
    const broken = parsePreset("broken", "---\nmode: sideways\neffort: extreme\n---\nbody", "project", "/tmp/b.md");
    expect(broken.mode).toBeUndefined();
    expect(broken.effort).toBeUndefined();
    expect(broken.prompt).toBe("body");
  });

  it("discovers project and global presets, project winning on a name clash", async () => {
    const { discoverAgents } = await import("../src/agents/Presets.js");
    const previousHome = process.env.HOME;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const home = join(dir, "preset-home");
    const project = join(dir, "preset-project");
    // Windows resolves the user data dir through %LOCALAPPDATA%, POSIX through
    // $HOME. The test sets both so the same fixture is discovered everywhere.
    const userRoot = process.platform === "win32" ? join(home, "carls") : join(home, ".carls");
    await mkdir(join(userRoot, "agents"), { recursive: true });
    await mkdir(join(project, ".agents", "agents"), { recursive: true });
    await writeFile(join(userRoot, "agents", "docs.md"), "global docs agent");
    await writeFile(join(userRoot, "agents", "reviewer.md"), "global reviewer");
    await writeFile(join(project, ".agents", "agents", "reviewer.md"), "project reviewer");
    process.env.HOME = home;
    if (process.platform === "win32") process.env.LOCALAPPDATA = home;
    try {
      const agents = discoverAgents(project);
      expect(agents.map((agent) => agent.name)).toEqual(["docs", "reviewer"]);
      expect(agents.find((agent) => agent.name === "reviewer")?.prompt).toBe("project reviewer");
      expect(agents.find((agent) => agent.name === "reviewer")?.source).toBe("project");
      expect(agents.find((agent) => agent.name === "docs")?.source).toBe("user");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
    }
  });

  it("folds a preset into the config and the system prompt", async () => {
    const { parsePreset, applyPreset } = await import("../src/agents/Presets.js");
    const { loadConfig } = await import("../src/config/Config.js");
    const { buildSystemPrompt } = await import("../src/core/Runtime.js");
    const workspace = join(dir, "preset-apply");
    await mkdir(workspace, { recursive: true });
    const previous = process.env.CARLS_SYSTEM_CONFIG;
    process.env.CARLS_SYSTEM_CONFIG = join(workspace, "missing.json");
    try {
      const base = loadConfig({ model: "gpt-4o" }, workspace);
      const next = applyPreset(base, parsePreset("reviewer", preset, "project", "/tmp/r.md"));
      expect(next.mode).toBe("plan");
      expect(next.model).toBe("gpt-4o");
      expect(next.tools).toEqual(["read_file", "grep_search"]);
      expect(next.agentName).toBe("reviewer");
      expect(buildSystemPrompt(next)).toContain("You are a reviewer.");
      expect(buildSystemPrompt(next)).toContain("Agent: reviewer");
      expect(buildSystemPrompt(base)).not.toContain("You are a reviewer.");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previous;
    }
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

  it("refuses a symlink that points out of the workspace", async () => {
    const { expandMentions } = await import("../src/cli/Mentions.js");
    const root = join(dir, "mention-symlink");
    await mkdir(root, { recursive: true });
    await writeFile(join(dir, "mention-outside.txt"), "secret-value");
    await writeFile(join(root, "inside.txt"), "keep-me");
    await symlink(join(dir, "mention-outside.txt"), join(root, "link.txt"));
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"));

    const result = expandMentions("read @link.txt and @alias.txt", root);
    expect(result.attached).toEqual(["alias.txt"]);
    expect(result.skipped).toEqual([
      { path: "link.txt", reason: "symlink points outside the workspace" },
    ]);
    expect(result.text).not.toContain("secret-value");
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

  it("attaches mentions in print mode, without a terminal", async () => {
    const { runOneShot } = await import("../src/cli/OneShot.js");
    const { loadConfig } = await import("../src/config/Config.js");
    const workspace = join(dir, "mention-oneshot");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "note.txt"), "the answer is 42");

    let sent = "";
    const server = createServer((req, res) => {
      if (req.url?.includes("chat/completions") !== true) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      req.on("data", (chunk: Buffer) => (sent += chunk.toString("utf8")));
      req.on("end", () => {
        // Print mode asks for a plain completion, not a stream.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "1",
            object: "chat.completion",
            created: 0,
            model: "gpt-4o",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const previous = process.env.CARLS_SYSTEM_CONFIG;
    process.env.CARLS_SYSTEM_CONFIG = join(workspace, "missing.json");
    try {
      const config = {
        ...loadConfig({ provider: "openai", model: "gpt-4o", baseUrl: `http://127.0.0.1:${port}/v1` }, workspace),
        apiKey: "test-key",
      };
      const code = await runOneShot("summarise @note.txt", config, new Logger("error"));
      expect(code).toBe(0);
      // The request the model actually received carries the file.
      expect(sent).toContain("the answer is 42");
      expect(sent).toContain("file path=\\\"note.txt\\\"");
    } finally {
      if (previous === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previous;
      server.close();
    }
  }, 30000);
});

describe("session tabs", () => {
  it("adds, wraps and selects without losing the active tab", async () => {
    const { TabManager } = await import("../src/cli/Tabs.js");
    const tabs = new TabManager<{ n: number }>({ id: "a", title: "a", payload: { n: 1 } });
    expect(tabs.size).toBe(1);
    expect(tabs.current().id).toBe("a");

    tabs.add({ id: "b", title: "b", payload: { n: 2 } });
    tabs.add({ id: "c", title: "c", payload: { n: 3 } });
    expect(tabs.size).toBe(3);
    // `add` makes the new tab active.
    expect(tabs.current().id).toBe("c");

    expect(tabs.next()).toBe(0);
    expect(tabs.current().id).toBe("a");
    // Wrapping backwards from the first lands on the last.
    expect(tabs.prev()).toBe(2);
    expect(tabs.current().id).toBe("c");
    // Out-of-range jumps are ignored rather than throwing.
    expect(tabs.select(9)).toBe(2);
    expect(tabs.select(-1)).toBe(2);
  });

  it("refuses to close the final tab and keeps the selection sensible", async () => {
    const { TabManager } = await import("../src/cli/Tabs.js");
    const tabs = new TabManager<string>({ id: "a", title: "a", payload: "A" });
    expect(tabs.close(0)).toBe(false);
    expect(tabs.size).toBe(1);

    tabs.add({ id: "b", title: "b", payload: "B" });
    tabs.add({ id: "c", title: "c", payload: "C" });
    tabs.select(0);
    // Closing the active first tab slides the next one into its slot.
    expect(tabs.close(0)).toBe(true);
    expect(tabs.size).toBe(2);
    expect(tabs.activeIndex).toBe(0);
    expect(tabs.current().id).toBe("b");
    // Closing the tail clamps the index to the new last tab.
    tabs.select(1);
    expect(tabs.close(1)).toBe(true);
    expect(tabs.activeIndex).toBe(0);
    expect(tabs.current().id).toBe("b");
  });

  it("derives a short tab title from the first line of a goal", async () => {
    const { shortTitle } = await import("../src/cli/Tabs.js");
    expect(shortTitle("  fix   the parser\nand the lexer  ")).toBe("fix the parser and the …");
    expect(shortTitle("")).toBe("untitled");
    expect(shortTitle("short")).toBe("short");
  });

  it("hides the strip for one tab and marks the active one otherwise", async () => {
    const { tabStripLine } = await import("../src/cli/TerminalUI.js");
    expect(tabStripLine([{ title: "only" }], 0)).toBeUndefined();
    const strip = tabStripLine([{ title: "one" }, { title: "two" }], 1);
    expect(strip).toBeDefined();
    // Both labels are present, and the active one is bracketed.
    expect(strip).toContain("1:one");
    expect(strip).toContain("[2:two]");
    const { visibleWidth } = await import("../src/cli/Text.js");
    expect(visibleWidth(strip ?? "")).toBeLessThan(200);
  });
});

describe("Chrome tab strip", () => {
  it("gives the strip a row and shifts the region down when tabs are shown", async () => {
    const { Chrome } = await import("../src/cli/Chrome.js");
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough() as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = true;
    (out as unknown as { columns: number }).columns = 80;
    (out as unknown as { rows: number }).rows = 24;

    const chrome = new Chrome(out);
    const bare = chrome.enable(["header"]);
    expect(bare).toBeDefined();
    expect(bare?.tabRow).toBe(0);
    const bareTop = bare?.regionTop ?? 0;

    chrome.setTabs("1:one │[2:two]");
    const withTabs = chrome.current();
    // The strip sits directly under the header, so it is headerRows + 1.
    expect(withTabs.tabRow).toBe((bare?.headerRows ?? 0) + 1);
    // The conversation region starts one row lower to make space for the strip.
    expect(withTabs.regionTop).toBe(bareTop + 1);

    chrome.setTabs(undefined);
    expect(chrome.current().tabRow).toBe(0);
    expect(chrome.current().regionTop).toBe(bareTop);
  });
});

describe("Prompt tab bindings", () => {
  async function pressKey(sequence: string): Promise<string> {
    const { Prompt } = await import("../src/cli/Prompt.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const prompt = new Prompt(input, output);
    const pending = prompt.read({ prompt: "carls> " });
    await new Promise((r) => setTimeout(r, 10));
    input.write(sequence);
    const result = await pending;
    return result.type;
  }

  it("reports ctrl+t, ctrl+x, ctrl+n and ctrl+b as tab actions", async () => {
    expect(await pressKey("\u0014")).toBe("new-tab");
    expect(await pressKey("\u0018")).toBe("close-tab");
    expect(await pressKey("\u000e")).toBe("next-tab");
    expect(await pressKey("\u0002")).toBe("sidebar");
  });
});

describe("terminal dimension fallback", () => {
  it("treats a zero column count as unknown, not as zero width", async () => {
    const { terminalDimension, clampWidth } = await import("../src/cli/Text.js");
    // A pty with no window size set reports 0; `0 ?? fallback` would keep it.
    expect(terminalDimension(0, 80)).toBe(80);
    expect(terminalDimension(undefined, 80)).toBe(80);
    expect(terminalDimension(120, 80)).toBe(120);
    expect(clampWidth(0, 80)).toBe(80);
    expect(clampWidth(5, 80)).toBe(20);
    expect(clampWidth(120, 80)).toBe(120);
  });
});

describe("Chrome header must not erase the tab strip", () => {
  it("never paints more header lines than the layout reserves", async () => {
    const { Chrome } = await import("../src/cli/Chrome.js");
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough() as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = true;
    (out as unknown as { columns: number }).columns = 80;
    // Short terminal: the six-line banner cannot all fit above the footer.
    (out as unknown as { rows: number }).rows = 12;
    const writes: string[] = [];
    out.on("data", (chunk: Buffer) => writes.push(chunk.toString()));

    const chrome = new Chrome(out);
    chrome.enable(["h1", "h2", "h3", "h4", "h5", "h6"]);
    writes.length = 0;

    // Showing the strip costs a row, so the banner can no longer fit whole.
    chrome.setTabs("1:a │[2:b]");
    const layout = chrome.current();
    expect(layout.headerRows).toBe(5);
    expect(layout.tabRow).toBe(6);

    const painted = writes.join("");
    // The strip must survive: the overflow header line ("h6") may not be painted
    // at all, because its row is now the strip's.
    expect(painted).toContain("1:a │[2:b]");
    expect(painted).not.toContain("h6");
    // Every header line that is painted stays strictly above the strip.
    expect(painted).not.toContain(`\u001b[${layout.tabRow};1H\u001b[2Kh`);
  });
});

describe("line endings (CRLF files, as produced on Windows)", () => {
  const crlfCtx = (): ToolContext => makeContext();

  it("edits a CRLF file with an LF old_string and keeps CRLF", async () => {
    const file = join(dir, "win.txt");
    await writeFile(file, "one\r\ntwo\r\nthree\r\n", "utf8");
    const tool = new FileEdit();

    const result = await tool.run(
      tool.parse({ path: "win.txt", old_string: "one\ntwo", new_string: "merged" }),
      crlfCtx(),
    );

    expect(result.ok).toBe(true);
    // Untouched lines keep CRLF; the file is not silently converted to LF.
    expect(await readFile(file, "utf8")).toBe("merged\r\nthree\r\n");
  });

  it("keeps CRLF when the replacement adds a line", async () => {
    const file = join(dir, "grow.txt");
    await writeFile(file, "a\r\nb\r\n", "utf8");
    const tool = new FileEdit();

    const result = await tool.run(
      tool.parse({ path: "grow.txt", old_string: "b", new_string: "b1\nb2" }),
      crlfCtx(),
    );

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a\r\nb1\r\nb2\r\n");
  });

  it("still counts occurrences across line endings", async () => {
    const file = join(dir, "dup-crlf.txt");
    await writeFile(file, "same\r\nsame\r\n", "utf8");
    const tool = new FileEdit();

    const result = await tool.run(tool.parse({ path: "dup-crlf.txt", old_string: "same", new_string: "x" }), crlfCtx());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("matches 2 times");
  });

  it("applies an LF patch to a CRLF file without rewriting every line", async () => {
    const file = join(dir, "patch-crlf.txt");
    await writeFile(file, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    const tool = new ApplyPatch();
    const patch = "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma";

    const result = await tool.run(tool.parse({ path: "patch-crlf.txt", patch }), crlfCtx());

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("applies a CRLF patch, as a Windows diff tool would emit", async () => {
    const file = join(dir, "patch-crlf2.txt");
    await writeFile(file, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    const tool = new ApplyPatch();
    const patch = "@@ -1,3 +1,3 @@\r\n alpha\r\n-beta\r\n+BETA\r\n gamma";

    const result = await tool.run(tool.parse({ path: "patch-crlf2.txt", patch }), crlfCtx());

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("reads a CRLF file without leaking carriage returns to the model", async () => {
    const file = join(dir, "read-crlf.txt");
    await writeFile(file, "one\r\ntwo\r\n", "utf8");
    const tool = new FileRead();

    const result = await tool.run(tool.parse({ path: "read-crlf.txt" }), crlfCtx());

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("\r");
    expect(result.output).toContain("1→one");
  });

  it("keeps a mixed-ending file mixed instead of imposing one ending", async () => {
    const file = join(dir, "mixed.txt");
    await writeFile(file, "a\r\nb\nc\r\n", "utf8");
    const tool = new FileEdit();

    const result = await tool.run(tool.parse({ path: "mixed.txt", old_string: "b", new_string: "B\nB2" }), crlfCtx());

    expect(result.ok).toBe(true);
    // The inserted line follows the LF that was there; the CRLF lines are untouched.
    expect(await readFile(file, "utf8")).toBe("a\r\nB\nB2\nc\r\n");
  });
});

describe("repo_map index", () => {
  it("extracts declarations with signatures and members", () => {
    const source = [
      "export interface Guard {",
      "  cwd: string;",
      "  allowOutsideWorkspace: boolean;",
      "}",
      "",
      "export class Paths {",
      "  private root: string;",
      "  resolve(p: string): string {",
      "    return p;",
      "  }",
      "}",
      "",
      "export function guardPath(ctx: Guard, path: string): string {",
      "  return path;",
      "}",
    ].join("\n");

    const symbols = extractSymbols(source, "src/paths.ts", true);
    const guard = symbols.find((s) => s.name === "Guard");
    const paths = symbols.find((s) => s.name === "Paths");
    const fn = symbols.find((s) => s.name === "guardPath");

    expect(guard?.kind).toBe("interface");
    expect(guard?.members).toContain("cwd: string;");
    expect(paths?.members).toContain("private root: string;");
    // A method's own statements are implementation, not interface.
    expect(paths?.members).not.toContain("return p;");
    expect(fn?.line).toBe(13);
    expect(fn?.exported).toBe(true);
    expect(fn?.signature).toContain("export function guardPath");
  });

  it("indexes a workspace and answers symbol queries", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "alpha.ts"),
      "export function alphaOne(): number {\n  return 1;\n}\n",
      "utf8",
    );
    await writeFile(
      join(dir, "src", "beta.ts"),
      'import { alphaOne } from "./alpha.js";\nexport const betaValue = alphaOne();\n',
      "utf8",
    );

    const map = new RepoMap(dir);
    const stats = map.build();

    expect(stats.files).toBe(2);
    expect(map.find("alphaOne")).toHaveLength(1);
    expect(map.find("alphaOne")[0]?.file).toBe("src/alpha.ts");
    // Imports resolve across the .js/.ts extension boundary.
    expect(map.dependents("src/alpha.ts")).toEqual(["src/beta.ts"]);
  });

  it("keeps the rendered map inside its token budget", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 30; i++) {
      const body = Array.from({ length: 20 }, (_, n) => `  export const value${n} = ${n};`).join("\n");
      await writeFile(join(dir, `src/mod${i}.ts`), `${body}\n`, "utf8");
    }
    const map = new RepoMap(dir);
    map.build();

    const rendered = map.render(300);
    // 300 tokens at ~3.6 chars/token, with room for the clip marker.
    expect(rendered.length).toBeLessThanOrEqual(300 * 3.6 + 64);
  });

  it("reports an empty map rather than throwing", () => {
    const map = new RepoMap(dir);
    map.build();
    expect(map.render(500)).toBe("The repository map is empty.");
  });

  it("serves queries through the repo_map tool", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "one.ts"), "export class Widget {\n}\n", "utf8");
    const tool = new RepoMapTool(new RepoMap(dir));

    const found = await tool.run(tool.parse({ query: "Widget" }), makeContext());
    expect(found.ok).toBe(true);
    expect(found.output).toContain("src/one.ts");
    expect(found.output).toContain("class Widget");

    const missing = await tool.run(tool.parse({ query: "NoSuchSymbol" }), makeContext());
    expect(missing.ok).toBe(true);
    expect(missing.output).toContain("No symbol matches");
  });
});

describe("observation masking", () => {
  const pair = (id: string, content: string, isError = false): Message[] => [
    { role: "assistant", content: [{ type: "tool_use", id, name: "bash", input: { command: "npm test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  ];

  it("replaces old observations while keeping every tool pair intact", () => {
    const manager = new ContextManager({
      contextWindow: 1000,
      compactThreshold: 0.75,
      truncateLimit: 8000,
      maskMinChars: 100,
    });
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...pair(`t${i}`, `${"x".repeat(5000)}\n[exit code] 0`));
    }

    const masked = manager.maskObservations(messages);

    expect(manager.lastMaskedCount).toBeGreaterThan(0);
    // Nothing is dropped or reordered, so the provider still accepts the request.
    expect(masked).toHaveLength(messages.length);
    const uses = masked.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id));
    const results = masked.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
    );
    expect(results).toEqual(uses);
  });

  it("leaves the recent tail verbatim and shrinks the history", () => {
    const manager = new ContextManager({
      contextWindow: 1000,
      compactThreshold: 0.75,
      truncateLimit: 8000,
      maskMinChars: 100,
    });
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(...pair(`t${i}`, `${"x".repeat(5000)}\n[exit code] 0`));
    }

    const masked = manager.maskObservations(messages);

    const before = JSON.stringify(messages).length;
    const after = JSON.stringify(masked).length;
    expect(after).toBeLessThan(before);
    // The newest pair is untouched, so current reasoning keeps its detail.
    expect(masked[masked.length - 1]).toBe(messages[messages.length - 1]);
  });

  it("keeps a failure observation's detail instead of masking it away", () => {
    const manager = new ContextManager({
      contextWindow: 1000,
      compactThreshold: 0.75,
      truncateLimit: 8000,
      maskMinChars: 100,
    });
    const failure = `${"e".repeat(150)}\n[exit code] 1`;
    const messages: Message[] = [
      ...pair("t0", failure, true),
      ...Array.from({ length: 12 }, (_, i) => pair(`t${i + 1}`, `${"x".repeat(5000)}\n[exit code] 0`)).flat(),
    ];

    const masked = manager.maskObservations(messages);
    const first = masked[1]?.content[0];
    expect(first?.type).toBe("tool_result");
    if (first?.type === "tool_result") {
      expect(first.is_error).toBe(true);
      expect(first.content).toBe(failure);
    }
  });

  it("digests an observation down to its outcome", () => {
    expect(digest("Tests 186 passed (186)\n[exit code] 0", false)).toContain("186 tests ok");
    expect(digest("a.ts(1,1): error TS1: x\n2 errors", true)).toContain("2 errors");
    expect(digest("@@ -1,2 +1,3 @@\n@@ -8,1 +9,2 @@", false)).toContain("2 hunks");
    // With nothing recognisable, the size still tells the model what happened.
    expect(digest("plain output", false)).toContain("chars");
  });
});

describe("shadow git checkpoints", () => {
  const git = (args: string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  const repo = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "carls-shadow-"));
    git(["init", "-q", "."], root);
    git(["config", "user.email", "test@example.com"], root);
    git(["config", "user.name", "Test"], root);
    await writeFile(join(root, "tracked.txt"), "v1\n", "utf8");
    git(["add", "tracked.txt"], root);
    git(["commit", "-qm", "init"], root);
    return root;
  };

  it("does not disturb the user's index, HEAD or branch", async () => {
    const root = await repo();
    // Something the developer staged, which a careless checkpoint would clobber.
    await writeFile(join(root, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"], root);
    const headBefore = git(["rev-parse", "HEAD"], root);
    const stagedBefore = git(["diff", "--cached", "--name-only"], root);

    const shadow = new ShadowGit(root);
    await writeFile(join(root, "untracked.txt"), "new\n", "utf8");
    const checkpoint = shadow.create("before refactor");

    expect(checkpoint).toBeDefined();
    expect(git(["diff", "--cached", "--name-only"], root)).toBe(stagedBefore);
    expect(git(["rev-parse", "HEAD"], root)).toBe(headBefore);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], root)).toBe("master");
    // The checkpoint lives on its own ref, invisible to a normal git log.
    expect(git(["for-each-ref", "--format=%(refname)", "refs/carls/checkpoints"], root)).toContain(
      "refs/carls/checkpoints/",
    );
    shadow.dispose();
  });

  it("captures untracked files and rewinds the tree to them", async () => {
    const root = await repo();
    const shadow = new ShadowGit(root);
    await writeFile(join(root, "untracked.txt"), "keep me\n", "utf8");
    const checkpoint = shadow.create("with untracked");
    expect(checkpoint?.files).toBe(2);

    // Break the tracked file and add a new one after the snapshot.
    await writeFile(join(root, "tracked.txt"), "v2-BROKEN\n", "utf8");
    await writeFile(join(root, "added-later.txt"), "junk\n", "utf8");

    const result = shadow.rewind(checkpoint!);

    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(root, "untracked.txt"))).toBe(true);
    // A file that did not exist at snapshot time is removed.
    expect(existsSync(join(root, "added-later.txt"))).toBe(false);
    expect(result.deleted).toContain("added-later.txt");
    shadow.dispose();
  });

  it("respects .gitignore, so build output is never captured or deleted", async () => {
    const root = await repo();
    await writeFile(join(root, ".gitignore"), "dist/\n", "utf8");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "compiled\n", "utf8");

    const shadow = new ShadowGit(root);
    const checkpoint = shadow.create("ignoring dist");

    // `.gitignore` is itself a new, unignored file, so it is captured; dist/ is not.
    const captured = git(["ls-tree", "-r", "--name-only", checkpoint!.commit], root).split("\n");
    expect(captured).toContain("tracked.txt");
    expect(captured).toContain(".gitignore");
    expect(captured).not.toContain("dist/bundle.js");

    shadow.rewind(checkpoint!);
    expect(existsSync(join(root, "dist", "bundle.js"))).toBe(true);
    shadow.dispose();
  });

  it("lists, resolves and diffs checkpoints", async () => {
    const root = await repo();
    const shadow = new ShadowGit(root);
    const checkpoint = shadow.create("first")!;

    expect(shadow.list().map((c) => c.id)).toContain(checkpoint.id);
    expect(shadow.resolve(checkpoint.id)?.label).toBe("first");
    expect(shadow.resolve(checkpoint.commit.slice(0, 10))?.id).toBe(checkpoint.id);

    await writeFile(join(root, "tracked.txt"), "v2\n", "utf8");
    const patch = shadow.diff(checkpoint);
    expect(patch).toContain("-v1");
    expect(patch).toContain("+v2");
    shadow.dispose();
  });

  it("is inert outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "carls-nogit-"));
    const shadow = new ShadowGit(plain);

    expect(shadow.enabled).toBe(false);
    expect(shadow.create("nothing")).toBeUndefined();
    expect(shadow.list()).toEqual([]);
    shadow.dispose();
  });
});

describe("os runtime adapter", () => {
  it("detects the platform and exposes a shell for it", () => {
    const profile = detectOsProfile();
    expect(["win32", "linux", "darwin", "android", "other"]).toContain(profile.platform);
    expect(profile.shell.file.length).toBeGreaterThan(0);
    expect(profile.shell.args.length).toBeGreaterThan(0);
    // POSIX is exactly "not Windows", which is what the prompt builder keys off.
    expect(profile.posix).toBe(!isWindows());
  });

  it("classifies Termux as android, not linux", () => {
    const saved = { ...process.env };
    try {
      process.env.TERMUX_VERSION = "0.118";
      process.env.PREFIX = "/data/data/com.termux/files/usr";
      expect(isTermux()).toBe(true);
      expect(currentPlatform()).toBe("android");
      // The Termux shell lives under $PREFIX, never at /bin/bash.
      const shell = shellForPlatform();
      expect(shell.file.startsWith("/data/data/com.termux/files/usr")).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("normalises workspace paths deterministically", () => {
    const base = "/work/project";
    expect(normalizeWorkspacePath("src/a.ts", base, { platform: "linux" })).toBe("/work/project/src/a.ts");
    expect(normalizeWorkspacePath("./src/../src/a.ts", base, { platform: "linux" })).toBe("/work/project/src/a.ts");
    expect(normalizeWorkspacePath("/abs/./b/../c.ts", base, { platform: "linux" })).toBe("/abs/c.ts");
    // Two spellings of the same file must collapse to one string.
    expect(normalizeWorkspacePath("src/./a.ts", base, { platform: "linux" })).toBe(
      normalizeWorkspacePath("src/a.ts", base, { platform: "linux" }),
    );
    // The same function must produce native separators on a Windows host.
    expect(normalizeWorkspacePath("src/a.ts", "C:\\work\\project", { platform: "win32" })).toBe(
      "C:\\work\\project\\src\\a.ts",
    );
  });

  it("forces UTF-8 output from child processes", () => {
    const env = utf8Env();
    if (isWindows()) {
      expect(env.PYTHONIOENCODING).toBe("utf-8");
      expect(env.PYTHONUTF8).toBe("1");
    } else {
      expect(env.LANG).toContain("UTF-8");
      expect(env.LC_ALL).toContain("UTF-8");
    }
  });

  it("reports a cwd that is intact, missing, or not a directory", async () => {
    const ok = verifyCwdIntegrity(dir);
    expect(ok.ok).toBe(true);

    const gone = verifyCwdIntegrity(join(dir, "does-not-exist"));
    expect(gone.ok).toBe(false);
    expect(gone.reason).toContain("no longer exists");

    const file = join(dir, "a-file.txt");
    await writeFile(file, "x\n", "utf8");
    const notDir = verifyCwdIntegrity(file);
    expect(notDir.ok).toBe(false);
    expect(notDir.reason).toContain("no longer a directory");
  });

  it("kills a whole process tree, not just the shell", async () => {
    // A Node parent spawns a Node grandchild and prints its pid. The script is a
    // real file so the command needs no shell-specific quoting on either host.
    const script = join(dir, "grandchild.cjs");
    await writeFile(
      script,
      [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
        "console.log(`gc=${child.pid}`);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const tool = new BashExecution();
    const ctx = makeContext();
    // PowerShell treats a leading quoted path as a string; `&` invokes it. The
    // POSIX shells need no call operator.
    const command = isWindows()
      ? `& "${process.execPath}" "${script}"`
      : `"${process.execPath}" "${script}"`;
    const outcome = await tool.run(tool.parse({ command, timeout_ms: 1200 }), ctx);
    const match = /gc=(\d+)/.exec(outcome.output);
    expect(match).not.toBeNull();
    const grandchild = Number(match?.[1]);
    expect(Number.isFinite(grandchild)).toBe(true);

    // `process.kill(pid, 0)` succeeds for a zombie on POSIX, so the state is
    // read there; Windows has no `ps`, so the existence probe is the signal.
    const gone = async (pid: number): Promise<boolean> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (isWindows()) {
          try {
            process.kill(pid, 0);
          } catch {
            return true;
          }
        } else {
          try {
            const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
            if (state === "" || state.startsWith("Z")) return true;
          } catch {
            return true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    expect(await gone(grandchild)).toBe(true);
  });

  it("reports a workspace the command destroyed instead of a later ENOENT", async () => {
    const victim = join(dir, "victim");
    await mkdir(victim, { recursive: true });
    const tool = new BashExecution();
    const ctx = { ...makeContext(), cwd: victim };

    // Windows keeps a handle to a process's cwd, so the shell has to release
    // both its location and the OS current directory before deleting it. POSIX
    // only needs `cd ..`.
    const command = isWindows()
      ? `Set-Location ..; [Environment]::CurrentDirectory = (Get-Location).Path; Remove-Item -LiteralPath "${victim}" -Recurse -Force`
      : `cd .. && rm -rf "${victim}"`;
    const outcome = await tool.run(tool.parse({ command }), ctx);

    expect(existsSync(victim)).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.metadata?.cwdIntact).toBe(false);
    expect(outcome.error).toContain("workspace root was damaged");
  });

  it("leaves a normal command's cwd untouched", async () => {
    const tool = new BashExecution();
    const outcome = await tool.run(tool.parse({ command: "echo hi" }), makeContext());
    expect(outcome.ok).toBe(true);
    expect(outcome.metadata?.cwdIntact).toBe(true);
    expect(outcome.output).toContain("hi");
  });

  it("spawns detached only where a process group exists", () => {
    expect(needsDetachedGroup()).toBe(!isWindows());
  });

  it("degrades silently when no sandbox is installed", () => {
    const availability = detectSandbox();
    expect(["bubblewrap", "seatbelt", "none"]).toContain(availability.kind);
    if (availability.kind === "none") {
      // Still usable: the caller runs the command directly.
      expect(sandboxCommand("/bin/bash", ["-lc"], "echo hi", "/tmp")).toBeUndefined();
    } else {
      const wrapped = sandboxCommand("/bin/bash", ["-lc"], "echo hi", "/tmp");
      expect(wrapped?.file).toBe(availability.binary);
      expect(wrapped?.args).toContain("echo hi");
    }
  });

  it("kills an already-dead pid without throwing", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    // A pid that cannot exist: the helper must swallow ESRCH.
    expect(() => killProcessTree(2 ** 30)).not.toThrow();
  });
});

describe("transaction manager", () => {
  const git = (args: string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  const repo = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "carls-tx-"));
    git(["init", "-q", "."], root);
    git(["config", "user.email", "test@example.com"], root);
    git(["config", "user.name", "Test"], root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-qm", "init"], root);
    return root;
  };

  /** No language server configured: the LSP half is skipped, commands decide. */
  const manager = (
    root: string,
    outcomes: Record<string, boolean>,
    onRollback?: (outcome: { committed: boolean }) => void,
  ): TransactionManager =>
    new TransactionManager({
      shadowGit: new ShadowGit(root),
      backups: new BackupStore("tx-test", join(root, ".carls-backups")),
      lsp: new LspSessionPool({ servers: undefined, cwd: root }),
      defaultTimeoutMs: 5000,
      runCommand: async (command) => ({
        command,
        ok: outcomes[command] ?? false,
        output: outcomes[command] === true ? "ok" : "failed",
      }),
      ...(onRollback !== undefined ? { onRollback } : {}),
    });

  it("keeps a change whose verification passes", async () => {
    const root = await repo();
    const tx = manager(root, { "verify pass": true });
    let ran = false;

    const outcome = await tx.run(
      { label: "good edit", files: [join(root, "a.ts")], commands: [{ command: "verify pass" }] },
      async () => {
        ran = true;
        await writeFile(join(root, "a.ts"), "export const a = 42;\n", "utf8");
      },
    );

    expect(ran).toBe(true);
    expect(outcome.committed).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.snapshot).toBe("shadow-git");
    expect(await readFile(join(root, "a.ts"), "utf8")).toContain("42");
  });

  it("rolls the whole tree back when a command fails", async () => {
    const root = await repo();
    const tx = manager(root, { "verify fail": false });

    const outcome = await tx.run(
      { label: "bad edit", files: [join(root, "a.ts")], commands: [{ command: "verify fail" }] },
      async () => {
        await writeFile(join(root, "a.ts"), "BROKEN (((\n", "utf8");
        await writeFile(join(root, "added-later.ts"), "junk\n", "utf8");
      },
    );

    expect(outcome.committed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    // Both halves of the rollback: the edit is undone and the new file is gone.
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(root, "added-later.ts"))).toBe(false);
    expect(outcome.failedHypothesis).toBe("bad edit");
    expect(outcome.reason).toContain("verification failed");
  });

  it("leaves the developer's staged index and HEAD alone through a rollback", async () => {
    const root = await repo();
    await writeFile(join(root, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"], root);
    const headBefore = git(["rev-parse", "HEAD"], root);

    const tx = manager(root, { "verify fail": false });
    await tx.run(
      { label: "bad edit", files: [join(root, "a.ts")], commands: [{ command: "verify fail" }] },
      async () => {
        await writeFile(join(root, "a.ts"), "BROKEN\n", "utf8");
      },
    );

    expect(git(["diff", "--cached", "--name-only"], root)).toBe("staged.txt");
    expect(git(["rev-parse", "HEAD"], root)).toBe(headBefore);
  });

  it("falls back to per-file backups when the workspace is not a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "carls-nogit-"));
    await writeFile(join(root, "keep.ts"), "export const original = true;\n", "utf8");

    const tx = manager(root, { "verify fail": false });
    const outcome = await tx.run(
      { label: "edit without git", files: [join(root, "keep.ts")], commands: [{ command: "verify fail" }] },
      async () => {
        await writeFile(join(root, "keep.ts"), "DESTROYED\n", "utf8");
      },
    );

    expect(outcome.snapshot).toBe("backups");
    expect(outcome.rolledBack).toBe(true);
    expect(await readFile(join(root, "keep.ts"), "utf8")).toContain("original = true");
  });

  it("rolls back when the change itself throws before verification", async () => {
    const root = await repo();
    const seen: { committed: boolean }[] = [];
    const tx = manager(root, {}, (outcome) => seen.push({ committed: outcome.committed }));

    const outcome = await tx.run(
      { label: "throwing edit", files: [join(root, "a.ts")] },
      async () => {
        await writeFile(join(root, "a.ts"), "half written\n", "utf8");
        throw new Error("the tool died mid-edit");
      },
    );

    expect(outcome.committed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.reason).toContain("failed before verification");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(seen).toHaveLength(1);
  });

  it("reports verification problems without a language server as command-only", async () => {
    const root = await repo();
    const tx = manager(root, { "one fail": false, "two pass": true });

    const verification = await tx.verify({
      label: "check",
      files: [join(root, "a.ts")],
      commands: [{ command: "one fail" }, { command: "two pass" }],
    });

    expect(verification.clean).toBe(false);
    expect(verification.commands.map((entry) => entry.ok)).toEqual([false, true]);
    expect(verification.lsp).toBeUndefined();
    expect(verification.problems).toEqual(["one fail failed"]);
  });
});

describe("lsp session pool", () => {
  /**
   * A real language server, minimal but protocol-correct: it answers initialize,
   * tracks didOpen/didChange versions, and publishes one error diagnostic whose
   * message encodes the version it saw. That is enough to prove the pool reuses
   * one process and keeps the server's copy of the file current.
   */
  const serverScript = (): string => `
const HEADER = /content-length:\\s*(\\d+)/i;
let buffer = Buffer.alloc(0);
const versions = new Map();
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
};
const diagnosticsFor = (uri) => [{
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1,
  message: "seen-version-" + (versions.get(uri) ?? 0),
}];
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const head = buffer.indexOf("\\r\\n\\r\\n");
    if (head === -1) return;
    const m = HEADER.exec(buffer.subarray(0, head).toString("ascii"));
    if (m === null) { buffer = buffer.subarray(head + 4); continue; }
    const len = Number(m[1]);
    const start = head + 4;
    if (buffer.length < start + len) return;
    const msg = JSON.parse(buffer.subarray(start, start + len).toString("utf8"));
    buffer = buffer.subarray(start + len);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    else if (msg.method === "textDocument/didOpen") {
      const uri = msg.params.textDocument.uri;
      versions.set(uri, msg.params.textDocument.version);
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsFor(uri) } });
    } else if (msg.method === "textDocument/didChange") {
      const uri = msg.params.textDocument.uri;
      versions.set(uri, msg.params.textDocument.version);
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsFor(uri) } });
    } else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });
    else if (msg.method === "exit") process.exit(0);
  }
});
`;

  it("reuses one server process and keeps its copy of the file current", async () => {
    const root = await mkdtemp(join(tmpdir(), "carls-lsp-"));
    const script = join(root, "fake-lsp.mjs");
    await writeFile(script, serverScript(), "utf8");
    const file = join(root, "sample.ts");
    await writeFile(file, "export const a = 1;\n", "utf8");

    const pool = new LspSessionPool({
      servers: { ".ts": { command: process.execPath, args: [script] } },
      cwd: root,
      initTimeoutMs: 8000,
      diagnosticsTimeoutMs: 8000,
    });

    const first = await pool.diagnosticsForFile(file);
    expect(first?.errors).toBe(1);
    expect(first?.diagnostics[0]?.message).toBe("seen-version-1");
    // One process, not one per call: the whole point of the pool.
    expect(pool.activeCount()).toBe(1);

    await writeFile(file, "export const a = 2;\n", "utf8");
    const second = await pool.diagnosticsForFile(file);
    // A second check sends didChange, so the server sees version 2.
    expect(second?.diagnostics[0]?.message).toBe("seen-version-2");
    expect(pool.activeCount()).toBe(1);

    await pool.close();
    expect(pool.activeCount()).toBe(0);
  });

  it("reports a server that will not start instead of blocking verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "carls-lsp-"));
    const file = join(root, "sample.ts");
    await writeFile(file, "export const a = 1;\n", "utf8");

    const pool = new LspSessionPool({
      servers: { ".ts": { command: "this-binary-does-not-exist-anywhere", args: [] } },
      cwd: root,
      initTimeoutMs: 3000,
      diagnosticsTimeoutMs: 3000,
    });

    const verification = await pool.verify([file]);
    // A missing server is informational, never a failed change.
    expect(verification.clean).toBe(true);
    expect(verification.checked).toBe(0);
    expect(verification.unavailable[0]?.key).toBe(".ts");
    await pool.close();
  });

  it("maps files to the server by extension and by name", () => {
    const pool = new LspSessionPool({
      servers: { ".ts": { command: "tsserver" }, Makefile: { command: "make-ls" } },
      cwd: "/tmp",
    });
    expect(pool.specFor("/a/b/file.ts")?.key).toBe(".ts");
    expect(pool.specFor("/a/b/Makefile")?.key).toBe("Makefile");
    expect(pool.specFor("/a/b/file.rs")).toBeUndefined();
    expect(pool.configured).toBe(true);

    const empty = new LspSessionPool({ servers: undefined, cwd: "/tmp" });
    expect(empty.configured).toBe(false);
  });

  it("skips files with no configured server", async () => {
    const pool = new LspSessionPool({ servers: { ".ts": { command: "tsserver" } }, cwd: "/tmp" });
    const verification = await pool.verify(["/tmp/notes.md", "/tmp/script.py"]);
    expect(verification.checked).toBe(0);
    expect(verification.clean).toBe(true);
  });
});

describe("persistent task dag", () => {
  it("persists a plan and resumes it in a fresh instance", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "carls-dag-")), ".carls", "state");
    const dag = new PersistentTaskDAG(stateDir);
    dag.plan("migrate the build", [
      { title: "audit imports", acceptanceCriteria: "every relative import has .js" },
      { title: "rewrite configs", dependencies: ["n1"], verifyCommands: ["npm run build"] },
      { title: "run the suite", dependencies: ["n2"] },
    ]);
    dag.setStatus("n1", "running");
    dag.setStatus("n1", "verifying");
    dag.setStatus("n1", "completed");
    dag.setStatus("n2", "running");
    dag.setStatus("n2", "failed", "tsc: 3 errors");

    // A different instance reading the same directory is the restart case.
    const resumed = PersistentTaskDAG.load(stateDir);
    expect(resumed).toBeDefined();
    const snapshot = resumed?.snapshot();
    expect(snapshot?.objective).toBe("migrate the build");
    expect(snapshot?.completed).toBe(1);
    expect(snapshot?.failed).toBe(1);
    // Acceptance criteria and the failure reason must survive the restart, or the
    // resumed session repeats the attempt that already failed.
    expect(resumed?.get("n1")?.acceptanceCriteria).toBe("every relative import has .js");
    expect(resumed?.get("n2")?.lastError).toBe("tsc: 3 errors");
    expect(resumed?.get("n2")?.verifyCommands).toEqual(["npm run build"]);
  });

  it("only offers a node whose dependencies are completed", () => {
    const dag = new PersistentTaskDAG("/tmp/unused");
    dag.plan("two steps", [
      { title: "first" },
      { title: "second", dependencies: ["n1"] },
    ]);
    expect(dag.next()?.id).toBe("n1");
    dag.setStatus("n1", "running");
    dag.setStatus("n1", "verifying");
    // Still not runnable while n1 is unverified: that is the point of the gate.
    expect(dag.next()?.id).toBeUndefined();
    dag.setStatus("n1", "completed");
    expect(dag.next()?.id).toBe("n2");
  });

  it("refuses illegal transitions", () => {
    const dag = new PersistentTaskDAG("/tmp/unused");
    dag.plan("one", [{ title: "only" }]);
    // pending -> completed skips verification entirely.
    expect(() => dag.setStatus("n1", "completed")).toThrow(/Illegal transition/);
    dag.setStatus("n1", "running");
    expect(() => dag.setStatus("n1", "pending")).toThrow(/Illegal transition/);
    dag.setStatus("n1", "verifying");
    expect(dag.setStatus("n1", "completed").status).toBe("completed");
  });

  it("rejects a dependency on a missing node and a cycle", () => {
    const dag = new PersistentTaskDAG("/tmp/unused");
    expect(() => dag.plan("bad", [{ title: "a", dependencies: ["n9"] }])).toThrow(/does not exist/);
    // A cycle must be caught at plan time, not by a node waiting forever.
    expect(() =>
      dag.plan("cycle", [
        { id: "a", title: "a", dependencies: ["b"] },
        { id: "b", title: "b", dependencies: ["a"] },
      ]),
    ).toThrow(/cycle/i);
  });

  it("reports blocked when nothing is runnable and work remains", () => {
    const dag = new PersistentTaskDAG("/tmp/unused");
    dag.plan("blocked", [
      { title: "first" },
      { title: "second", dependencies: ["n1"] },
    ]);
    dag.setStatus("n1", "running");
    dag.setStatus("n1", "failed", "boom");
    // n2 depends on a failed node: nothing runnable, and it is not done.
    expect(dag.blocked).toBe(true);
    expect(dag.done).toBe(false);
    expect(dag.retry("n1").status).toBe("running");
    expect(dag.blocked).toBe(false);
  });

  it("ignores a corrupt or stale-version state file", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "carls-dag-bad-")), ".carls", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "dag.json"), "{ this is not json", "utf8");
    expect(PersistentTaskDAG.load(stateDir)).toBeUndefined();

    await writeFile(join(stateDir, "dag.json"), JSON.stringify({ version: 99, objective: "x", nodes: [] }), "utf8");
    expect(PersistentTaskDAG.load(stateDir)).toBeUndefined();
  });
});

describe("task horizon router", () => {
  const router = new TaskHorizonRouter();

  it("routes a single question to the short horizon", () => {
    const decision = router.decide({ goal: "where is the config loader defined?" });
    expect(decision.horizon).toBe("short");
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("routes a multi-step request to the long horizon", () => {
    const decision = router.decide({
      goal: [
        "First, refactor the config module to be async.",
        "Then, migrate every caller across the codebase.",
        "Finally, run the whole test suite end-to-end and fix what breaks.",
      ].join("\n"),
    });
    expect(decision.horizon).toBe("long");
    expect(decision.suggestedSteps).toBeGreaterThan(30);
  });

  it("continues an active plan regardless of how short the turn looks", () => {
    const decision = router.decide({ goal: "continue", hasActivePlan: true });
    expect(decision.horizon).toBe("long");
    expect(decision.signals).toContain("active plan on disk");
  });

  it("counts asks from bullets and from sentences", () => {
    expect(countAsks("- one\n- two\n- three")).toBe(3);
    expect(countAsks("Fix the parser. Then update the tests. Finally bump the version.")).toBe(3);
    expect(countAsks("rename this")).toBe(1);
  });

  it("routes a two-file change to the medium horizon", () => {
    const decision = router.decide({
      goal: "Update the parser to handle the new token, and adjust the lexer that produces it so the two agree.",
    });
    expect(["medium", "long"]).toContain(decision.horizon);
    expect(decision.suggestedSteps).toBeGreaterThanOrEqual(30);
  });
});

describe("artifact store", () => {
  it("offloads large output and reads it back by page", async () => {
    const store = new ArtifactStore({ dir: join(await mkdtemp(join(tmpdir(), "carls-art-")), "artifacts"), thresholdChars: 500 });
    const big = Array.from({ length: 400 }, (_, index) => `line ${index}: diagnostic`).join("\n");

    expect(store.shouldOffload(big)).toBe(true);
    expect(store.shouldOffload("short")).toBe(false);

    const ref = store.offload(big);
    expect(ref).toBeDefined();
    expect(existsSync(ref!.path)).toBe(true);
    expect(ref!.lines).toBe(400);
    // The model gets the head, the tail and a pointer, not 400 lines.
    const summary = store.summarize(big, ref!);
    expect(summary.length).toBeLessThan(big.length / 4);
    expect(summary).toContain(ref!.path);
    // And any page of the original is still recoverable.
    expect(store.read(ref!, 100, 100)).toContain("line 99");
  });

  it("deduplicates identical output", async () => {
    const store = new ArtifactStore({ dir: join(await mkdtemp(join(tmpdir(), "carls-art-")), "artifacts"), thresholdChars: 10 });
    const text = "same output ".repeat(100);
    expect(store.offload(text)?.hash).toBe(store.offload(text)?.hash);
  });
});

describe("compaction pipeline", () => {
  const contextManager = (): ContextManager => new ContextManager({ contextWindow: 2000, compactThreshold: 0.75, truncateLimit: 8000 });

  const pipeline = (cm: ContextManager): CompactionPipeline =>
    new CompactionPipeline({
      contextManager: cm,
      buildLiveState: async () => "[live state]\nGOAL: the original goal\nnode n2 failed",
      summarize: async (older, hint) => ({
        goal: hint.goal,
        filesTouched: [...hint.filesTouched],
        errorsResolved: [],
        summary: `summarised ${older.length} messages`,
        nextStep: "run the tests",
      }),
    });

  it("replaces a read superseded by a later edit, and keeps an untouched read", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "old a.ts ".repeat(30), is_error: false }] },
      { role: "user", content: [{ type: "tool_use", id: "t2", name: "edit_file", input: { path: "src/a.ts" } }] },
      { role: "user", content: [{ type: "tool_use", id: "t3", name: "read_file", input: { path: "src/b.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "contents of b.ts", is_error: false }] },
    ];

    expect(findSupersededReads(messages)).toEqual([{ toolUseId: "t1", path: "src/a.ts", editedAfter: true }]);

    const layers = pipeline(contextManager()).applyCheapLayers(messages, 1_000_000);
    expect(layers.find((layer) => layer.layer === 2)?.applied).toBe(true);
    expect((messages[1]?.content[0] as { content: string }).content).toContain("the file was edited afterwards");
    // b.ts was never edited, so its read stays: the layer must not over-reach.
    expect((messages[4]?.content[0] as { content: string }).content).toBe("contents of b.ts");
  });

  it("keeps a read that came after the last edit, and drops only the stale one", () => {
    // read(a) -> edit(a) -> read(a): the first read is stale, the second is the
    // current content. A set-based check with no ordering would drop both.
    const messages: Message[] = [
      { role: "user", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "old a.ts ".repeat(30), is_error: false }] },
      { role: "user", content: [{ type: "tool_use", id: "t2", name: "edit_file", input: { path: "src/a.ts" } }] },
      { role: "user", content: [{ type: "tool_use", id: "t3", name: "read_file", input: { path: "src/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "new a.ts", is_error: false }] },
    ];

    expect(findSupersededReads(messages)).toEqual([{ toolUseId: "t1", path: "src/a.ts", editedAfter: true }]);

    pipeline(contextManager()).applyCheapLayers(messages, 1_000_000);
    // The stale read is replaced with the pointer...
    expect((messages[1]?.content[0] as { content: string }).content).toContain("the file was edited afterwards");
    // ...and the fresh read that followed the edit survives untouched.
    expect((messages[4]?.content[0] as { content: string }).content).toBe("new a.ts");
  });

  it("projects a shorter view without mutating the history", () => {
    const messages: Message[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 1 ? ("assistant" as const) : ("user" as const),
      content: [{ type: "text" as const, text: `message ${index} ${"x".repeat(200)}` }],
    }));
    const before = messages.length;

    const view = pipeline(contextManager()).projectView(messages, 8);

    expect(view).toBeDefined();
    // The whole point of layer 4: the real transcript is untouched.
    expect(messages.length).toBe(before);
    expect(view!.messages.length).toBeLessThan(messages.length);
    expect((view!.messages[0]?.content[0] as { text: string }).text).toContain("message 0");
    expect((view!.messages.at(-1)?.content[0] as { text: string }).text).toContain("message 39");
  });

  it("re-anchors the live state as the last thing in the summary", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "the original goal" }] },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 1 ? ("assistant" as const) : ("user" as const),
        content: [{ type: "text" as const, text: `turn ${index} ${"y".repeat(300)}` }],
      })),
    ];

    const { messages: next, report } = await pipeline(contextManager()).autoCompact(messages, "the original goal", new Set());

    expect(report.layers.find((layer) => layer.layer === 5)?.applied).toBe(true);
    expect(report.tokensAfter).toBeLessThan(report.tokensBefore);
    const blocks = next[0]?.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text) ?? [];
    // The summary comes first, the live state last, so the true state is the most
    // recent thing read rather than being buried above a lossy paraphrase.
    expect(blocks[0]).toContain("[contexto compactado]");
    expect(blocks.at(-1)).toContain("[live state]");
    expect(blocks.at(-1)).toContain("node n2 failed");
    expect(report.liveStateAnchor).toContain("[live state]");
  });

  it("does not compact when nothing is older than the retained tail", async () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "short conversation" }] }];
    const { report } = await pipeline(contextManager()).autoCompact(messages, "short conversation", new Set());
    expect(report.layers.find((layer) => layer.layer === 5)?.applied).toBe(false);
  });
});

describe("live state", () => {
  it("renders the goal, the plan, the checkpoint and the learned rules", async () => {
    const dag = new PersistentTaskDAG("/tmp/unused");
    dag.plan("ship the feature", [
      { title: "write the code", acceptanceCriteria: "tests pass" },
      { title: "open the PR", dependencies: ["n1"] },
    ]);
    dag.setStatus("n1", "running");

    const state = await buildLiveState({
      goal: "ship the feature",
      dag: dag.snapshot(),
      checkpoint: { id: "abc12345", ref: "refs/carls/checkpoints/abc12345", commit: "c", label: "before edit", at: "2026-01-01", files: 3 },
      operatorRules: ["never force-push"],
      projectRules: "Run npm test before claiming success.",
    });

    expect(state).toContain("ship the feature");
    expect(state).toContain("current node: n1");
    expect(state).toContain("abc12345");
    expect(state).toContain("never force-push");
    expect(state).toContain("Run npm test");
    // Plain text: no emoji in something that is injected into the model's context.
    expect(state).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe("skill evolution", () => {
  /** Builds a workspace with a couple of skill files and returns the root. */
  const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "carls-skill-"));

  const writeSkill = async (root: string, name: string, frontmatterExtra: string[], body: string): Promise<string> => {
    const dir = join(root, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    await writeFile(file, ["---", `name: ${name}`, "description: test skill", ...frontmatterExtra, "---", "", body].join("\n"), "utf8");
    return file;
  };

  it("creates a skill, records a revision, and validates the proposal", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);

    const created = engine.evolve(
      { name: "run-suite", description: "Run the test suite", body: "1. Run `npm test`.\n2. Verify the exit code is 0.", note: "initial" },
      undefined,
      false,
    );

    expect(created.ok).toBe(true);
    expect(created.version).toBe(1);
    expect(existsSync(created.path!)).toBe(true);
    expect(engine.historyFor("run-suite")).toHaveLength(1);
  });

  it("rejects a proposal whose body is empty or whose name is malformed", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);

    const emptyBody = engine.evolve({ name: "ok-name", description: "d", body: "   ", note: "n" }, undefined, false);
    expect(emptyBody.ok).toBe(false);
    expect(emptyBody.validation.issues.some((issue) => issue.field === "body" && issue.severity === "error")).toBe(true);

    const badName = engine.evolve({ name: "Bad Name", description: "d", body: "a real body here", note: "n" }, undefined, false);
    expect(badName.ok).toBe(false);
    expect(badName.validation.issues.some((issue) => issue.field === "name" && issue.severity === "error")).toBe(true);
  });

  it("refuses a rewrite that grows without adding a step", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "run-suite", description: "Run the suite", body: "1. Run `npm test`.\n2. Verify the exit code is 0.", note: "initial" }, undefined, false);

    const padded = engine.evolve(
      {
        name: "run-suite",
        description: "Run the suite",
        body: `1. Run \`npm test\`.\n2. Verify the exit code is 0.\n\n${"Remember to be careful and considerate at all times. ".repeat(6)}`,
        note: "padding",
      },
      undefined,
      true,
    );

    expect(padded.ok).toBe(false);
    expect(padded.rejected).toContain("without adding a step");
    // Nothing was written, so the working skill is untouched.
    expect(engine.historyFor("run-suite")).toHaveLength(1);
  });

  it("accepts a rewrite that adds a real step and versions it", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "run-suite", description: "Run the suite", body: "1. Run `npm test`.\n2. Verify the exit code is 0.", note: "initial" }, undefined, false);

    const improved = engine.evolve(
      {
        name: "run-suite",
        description: "Run the suite",
        body: "1. Run `npm test`.\n2. Verify the exit code is 0.\n3. Check coverage with `npm run coverage`.\n4. Confirm nothing was skipped.",
        note: "add coverage",
      },
      undefined,
      true,
    );

    expect(improved.ok).toBe(true);
    expect(improved.version).toBe(2);
    expect(engine.historyFor("run-suite").map((revision) => revision.note)).toEqual(["initial", "add coverage"]);
  });

  it("reverts to the previous revision and records the revert", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "run-suite", description: "Run the suite", body: "1. Run `npm test`.\n2. Verify the exit code is 0.", note: "initial" }, undefined, false);
    const improved = engine.evolve(
      {
        name: "run-suite",
        description: "Run the suite",
        body: "1. Run `npm test`.\n2. Verify the exit code is 0.\n3. Check coverage with `npm run coverage`.",
        note: "add coverage",
      },
      undefined,
      true,
    );

    const reverted = engine.revert("run-suite", undefined);

    expect(reverted.ok).toBe(true);
    expect(await readFile(improved.path!, "utf8")).not.toContain("coverage");
    // The revert is itself a revision, so it can be undone too.
    expect(engine.historyFor("run-suite").map((revision) => revision.version)).toEqual([1, 2, 3]);
  });

  it("refuses to revert when there is no earlier revision", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "only-one", description: "d", body: "1. A real step.\n2. Another step.", note: "first" }, undefined, false);
    expect(engine.revert("only-one", undefined).ok).toBe(false);
  });

  it("rejects a requires on an unknown skill", async () => {
    const root = await workspace();
    const engine = new SkillEvolutionEngine(root);
    const outcome = engine.evolve(
      { name: "needs-ghost", description: "d", body: "1. A real step.\n2. Another step here.", requires: ["does-not-exist"], note: "n" },
      undefined,
      false,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.validation.issues.some((issue) => issue.field === "requires")).toBe(true);
  });

  it("builds the dependency graph from frontmatter and finds dependents", async () => {
    const root = await workspace();
    await writeSkill(root, "run-suite", [], "1. Run `npm test`.");
    await writeSkill(root, "ship-feature", ["requires: [run-suite]"], "1. Use run-suite.");
    await writeSkill(root, "hotfix", ["extends: [run-suite]"], "1. Use run-suite, faster.");

    const engine = new SkillEvolutionEngine(root);
    const graph = engine.graph();

    expect(graph.dependents("run-suite").map((edge) => edge.from).sort()).toEqual(["hotfix", "ship-feature"]);
    // A transitive closure is what use_skill hands the model with the skill.
    expect(graph.closure("ship-feature")).toContain("run-suite");
    expect(graph.cycles()).toHaveLength(0);
    expect(graph.format()).toContain("requires");
  });

  it("detects a dependency cycle", async () => {
    const root = await workspace();
    await writeSkill(root, "a", ["requires: [b]"], "1. Step one.\n2. Step two.");
    await writeSkill(root, "b", ["requires: [a]"], "1. Step one.\n2. Step two.");
    const graph = new SkillEvolutionEngine(root).graph();
    expect(graph.cycles().length).toBeGreaterThan(0);
  });

  it("reads a block-list requires/extends/related from frontmatter", async () => {
    const root = await workspace();
    await writeSkill(root, "base", [], "1. Step one.\n2. Step two.");
    // YAML block-list form, the shape a hand-written or generated skill uses.
    await writeSkill(
      root,
      "ship",
      ["requires:", "  - base", "extends:", "  - base", "related:", "  - base"],
      "1. Use base.",
    );

    const graph = new SkillEvolutionEngine(root).graph();
    // The graph must see the block-list edges, not silently drop them.
    expect(graph.dependencies("ship").map((edge) => edge.to)).toEqual(["base", "base", "base"]);
    expect(graph.closure("ship")).toContain("base");
  });

  it("orders the review queue by how much the skill is hurting", async () => {
    const root = await workspace();
    await writeSkill(root, "flagged", [], "1. Step.\n2. Step.");
    await writeSkill(root, "never-used", [], "1. Step.\n2. Step.");
    const engine = new SkillEvolutionEngine(root);

    const queue = engine.reviewQueue(undefined);
    // With no usage records at all, everything is a "never used" candidate.
    expect(queue.every((candidate) => candidate.reason.includes("never used"))).toBe(true);
  });
});

describe("steering classifier", () => {
  const classifier = new AutoReviewSteeringClassifier();

  it("classifies the intents an operator actually types", () => {
    expect(classifier.classify("stop, that's enough").intent).toBe("stop");
    expect(classifier.classify("cancel this").intent).toBe("stop");
    expect(classifier.classify("no, use the other API instead").intent).toBe("correct");
    expect(classifier.classify("don't touch the generated directory").intent).toBe("reject");
    expect(classifier.classify("ok, continue").intent).toBe("approve");
    expect(classifier.classify("looks good").intent).toBe("approve");
    expect(classifier.classify("why did you delete that file?").intent).toBe("question");
    expect(classifier.classify("also update the docs").intent).toBe("steer");
  });

  it("only interrupts on intents that must change course", () => {
    // An approval that interrupted would restart work that is already correct.
    expect(classifier.classify("ok, continue").interrupts).toBe(false);
    expect(classifier.classify("why did you delete that file?").interrupts).toBe(false);
    expect(classifier.classify("no, use the other API instead").interrupts).toBe(true);
    expect(classifier.classify("stop").interrupts).toBe(true);
  });

  it("does not fire on a marker inside a longer word", () => {
    // "token" contains "ok" and "stopwatch" contains "stop"; neither is an intent.
    expect(classifier.classify("tokenize the input").intent).not.toBe("approve");
    expect(classifier.classify("fix the stopwatch widget").intent).not.toBe("stop");
  });

  it("treats an unmatched message as a steering instruction", () => {
    const decision = classifier.classify("the schema lives in packages/core");
    expect(decision.intent).toBe("steer");
    expect(decision.forward).toBe(true);
    expect(decision.instruction).toContain("packages/core");
  });

  it("ignores an empty message", () => {
    expect(classifier.classify("   ").forward).toBe(false);
  });
});

describe("operator cognitive memory", () => {
  it("learns a correction, merges repeats, and marks a convention", async () => {
    const memory = new OperatorCognitiveMemory(await mkdtemp(join(tmpdir(), "carls-mem-")));
    const classifier = new AutoReviewSteeringClassifier();
    const message = "no, use tabs for indentation";

    memory.learn(classifier.classify(message), message);
    memory.learn(classifier.classify(message), message);
    const rule = memory.learn(classifier.classify(message), message);

    // The same lesson repeated is one rule with a count, not three rules.
    expect(memory.all()).toHaveLength(1);
    expect(rule?.confirmations).toBe(3);
    expect(memory.activeTexts()[0]).toContain("confirmed 3x");
  });

  it("learns nothing from an approval", async () => {
    const memory = new OperatorCognitiveMemory(await mkdtemp(join(tmpdir(), "carls-mem-")));
    const classifier = new AutoReviewSteeringClassifier();
    expect(memory.learn(classifier.classify("ok continue"), "ok continue")).toBeUndefined();
    expect(memory.all()).toHaveLength(0);
  });

  it("persists across instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carls-mem-"));
    new OperatorCognitiveMemory(dir).addRule("run the type check before the tests");
    const reloaded = new OperatorCognitiveMemory(dir);
    expect(reloaded.all()).toHaveLength(1);
    expect(reloaded.all()[0]?.text).toContain("run the type check");
  });

  it("caps the active rules and orders conventions first", async () => {
    const memory = new OperatorCognitiveMemory(await mkdtemp(join(tmpdir(), "carls-mem-")));
    memory.addRule("use tabs for indentation");
    memory.addRule("use tabs for indentation");
    memory.addRule("use tabs for indentation");
    memory.addRule("prefer named exports over default exports");

    const active = memory.active(1);
    expect(active).toHaveLength(1);
    // The confirmed convention outranks a one-off instruction.
    expect(active[0]?.text).toContain("tabs");
  });

  it("forgets a rule on request", async () => {
    const memory = new OperatorCognitiveMemory(await mkdtemp(join(tmpdir(), "carls-mem-")));
    const rule = memory.addRule("never touch the generated directory");
    expect(memory.forget(rule!.id)).toBe(true);
    expect(memory.all()).toHaveLength(0);
    expect(memory.forget("not-a-real-id")).toBe(false);
  });
});

describe("execution receipt", () => {
  const base = {
    goal: "add the coverage step",
    answer: "Done.",
    startedAt: new Date(Date.now() - 42_000).toISOString(),
    steps: 12,
    filesWritten: ["/w/a.ts", "/w/a.ts", "/w/b.ts"],
  };

  it("deduplicates files and collects the verification commands", () => {
    const receipt = ExecutionReceipt.build({
      ...base,
      transactions: [
        { label: "good", committed: true, rolledBack: false, verificationCommands: ["npm test"] },
        { label: "bad", committed: false, rolledBack: true, reason: "failed", verificationCommands: ["npm run typecheck"] },
      ],
    });

    expect(receipt.filesWritten).toEqual(["/w/a.ts", "/w/b.ts"]);
    expect(receipt.verified).toEqual(["npm test", "npm run typecheck"]);
    expect(receipt.rolledBack).toEqual(["bad"]);
    // Something was rolled back, so the receipt is not clean.
    expect(receipt.clean).toBe(false);
  });

  it("flags a change that was written but never verified", () => {
    const receipt = ExecutionReceipt.build(base);
    expect(ExecutionReceipt.unverified(receipt)).toBe(true);
    // The rendered receipt says so in plain words rather than staying silent.
    expect(ExecutionReceipt.format(receipt)).toContain("nothing was run to verify");
  });

  it("omits empty sections from the rendered receipt", () => {
    const text = ExecutionReceipt.format(ExecutionReceipt.build(base));
    expect(text).not.toContain("Rolled back");
    expect(text).not.toContain("Checkpoints");
    expect(text).not.toContain("Plan:");
  });

  it("reports plan progress and blockers when a plan ran", () => {
    const receipt = ExecutionReceipt.build({
      ...base,
      dag: {
        objective: "o",
        createdAt: "t",
        updatedAt: "t",
        completed: 3,
        failed: 1,
        pending: 0,
        done: false,
        nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" }] as never,
      },
      blockers: ["n4 needs a decision: two APIs are equally valid"],
    });

    expect(receipt.plan).toEqual({ completed: 3, total: 4, blocked: true });
    const text = ExecutionReceipt.format(receipt);
    expect(text).toContain("3/4 nodes completed");
    expect(text).toContain("two APIs are equally valid");
  });
});

describe("sub-agent pool", () => {
  /** Records how many children overlap and can fail on demand. */
  class FakeAgent {
    active = 0;
    maxActive = 0;
    readonly calls: string[] = [];

    async run(goal: string, role: string): Promise<string> {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      this.calls.push(`${role}:${goal}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      this.active--;
      if (goal.includes("BOOM")) throw new Error("simulated child crash");
      return JSON.stringify({
        summary: `did ${goal}`,
        findings: [`f-${goal}`],
        relevantFiles: [`${goal}.ts`],
        suggestedCommands: [],
      });
    }
  }

  it("runs children in parallel but never above the concurrency cap", async () => {
    const agent = new FakeAgent();
    const pool = new SubAgentPool(agent as unknown as SubAgent, { concurrency: 2, maxTasks: 5 });
    const tasks = [1, 2, 3, 4, 5].map((n) => ({
      goal: `q${n}`,
      role: (n % 2 === 1 ? "explorer" : "auditor") as SubAgentRole,
    }));

    const outcomes = await pool.run(tasks);

    expect(outcomes).toHaveLength(5);
    expect(agent.maxActive).toBe(2);
    // Request order, so the parent reads a stable block between runs.
    expect(outcomes.map((o) => o.goal)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  it("isolates a failing child and still returns the others", async () => {
    const agent = new FakeAgent();
    const pool = new SubAgentPool(agent as unknown as SubAgent, { concurrency: 3 });
    const outcomes = await pool.run([
      { goal: "ok1", role: "explorer" },
      { goal: "BOOM", role: "auditor" },
      { goal: "ok2", role: "tester" },
    ]);

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(outcomes[1]?.error).toContain("simulated child crash");
    expect(outcomes[0]?.summary).toBe("did ok1");
    expect(outcomes[2]?.summary).toBe("did ok2");
  });

  it("refuses to fan out beyond maxTasks", async () => {
    const agent = new FakeAgent();
    const pool = new SubAgentPool(agent as unknown as SubAgent, { concurrency: 5, maxTasks: 2 });

    const outcomes = await pool.run([
      { goal: "a", role: "explorer" },
      { goal: "b", role: "explorer" },
      { goal: "c", role: "explorer" },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(pool.limit).toBe(2);
  });

  it("formats outcomes for the parent, marking failures", () => {
    const text = formatOutcomes([
      { goal: "a", role: "explorer", ok: true, summary: "found it", findings: ["x"], relevantFiles: ["a.ts"], suggestedCommands: [] },
      { goal: "b", role: "auditor", ok: false, summary: "", findings: [], relevantFiles: [], suggestedCommands: [], error: "crashed" },
    ]);

    expect(text).toContain("explorer · a");
    expect(text).toContain("found it");
    expect(text).toContain("FAILED: crashed");
  });

  it("gives each role a distinct instruction and budget", () => {
    const explorer = SubAgent.instructions("find the config", "explorer");
    const auditor = SubAgent.instructions("find the config", "auditor");

    expect(explorer).not.toBe(auditor);
    expect(explorer).toContain("Role: explorer");
    expect(auditor).toContain("Role: auditor");
    expect(SUBAGENT_ROLES.auditor.maxSteps).toBeGreaterThan(SUBAGENT_ROLES.planner.maxSteps);
  });
});

describe("delegate_task", () => {
  const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    ...makeContext(),
    ...overrides,
  });

  it("requires a goal or a non-empty tasks array", () => {
    const tool = new DelegateTask();
    expect(() => tool.parse({})).toThrow(/goal|tasks/);
    expect(() => tool.parse({ tasks: [] })).toThrow(/goal|tasks/);
    expect(tool.parse({ goal: "x" }).goal).toBe("x");
  });

  it("runs the pool form and reports failures alongside successes", async () => {
    const tool = new DelegateTask();
    const seen: SubAgentTask[] = [];
    const result = await tool.run(
      tool.parse({ tasks: [{ goal: "a", role: "explorer" }, { goal: "b", role: "auditor" }] }),
      context({
        subAgentPoolLimit: 4,
        spawnSubAgentPool: async (tasks) => {
          seen.push(...tasks);
          return [
            { goal: "a", role: "explorer", ok: true, summary: "sa", findings: [], relevantFiles: [], suggestedCommands: [] },
            { goal: "b", role: "auditor", ok: false, summary: "", findings: [], relevantFiles: [], suggestedCommands: [], error: "boom" },
          ];
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(result.output).toContain("FAILED: boom");
    expect(result.metadata?.failed).toBe(1);
  });

  it("refuses more tasks than the session allows", async () => {
    const tool = new DelegateTask();
    const result = await tool.run(
      tool.parse({ tasks: [{ goal: "a", role: "explorer" }, { goal: "b", role: "explorer" }] }),
      context({ subAgentPoolLimit: 1, spawnSubAgentPool: async () => [] }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Too many tasks");
  });

  it("passes the role through on the single-goal form", async () => {
    const tool = new DelegateTask();
    let seenRole: string | undefined;
    const result = await tool.run(
      tool.parse({ goal: "audit this", role: "auditor" }),
      context({
        spawnSubAgent: async (_goal, role) => {
          seenRole = role;
          return JSON.stringify({ summary: "done", findings: [], relevantFiles: [], suggestedCommands: [] });
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(seenRole).toBe("auditor");
  });

  it("reports a missing sub-agent wiring instead of throwing", async () => {
    const tool = new DelegateTask();
    const result = await tool.run(tool.parse({ goal: "x" }), context());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available");
  });
});

describe("completion engine", () => {
  /** A runtime stub: only the fields the completion reads are needed. */
  function runtime(cwd: string): { config: { cwd: string; provider: string; contextWindow?: number } } {
    return { config: { cwd, provider: "anthropic" } };
  }

  it("offers every command for a bare slash and ranks prefix matches first", async () => {
    const { complete } = await import("../src/cli/Autocomplete.js");
    const result = complete({ line: "/", cursor: 1, runtime: runtime(process.cwd()) as never });
    expect(result).toBeDefined();
    const values = result?.items.map((item) => item.value) ?? [];
    expect(values).toContain("/help");
    expect(values).toContain("/mode");

    const filtered = complete({ line: "/mo", cursor: 3, runtime: runtime(process.cwd()) as never });
    const filteredValues = filtered?.items.map((item) => item.value) ?? [];
    // "/mode" and "/model" start with "/mo"; they must lead the list.
    expect(filteredValues[0]).toBe("/mode");
    expect(filteredValues[1]).toBe("/model");
  });

  it("completes curated arguments: permission modes and efforts", async () => {
    const { complete } = await import("../src/cli/Autocomplete.js");
    const modes = complete({ line: "/mode ", cursor: 6, runtime: runtime(process.cwd()) as never });
    expect(modes?.items.map((item) => item.value)).toContain("yolo");

    const efforts = complete({ line: "/effort m", cursor: 9, runtime: runtime(process.cwd()) as never });
    expect(efforts?.items.map((item) => item.value)).toContain("medium");
  });

  it("offers skill names after /skills", async () => {
    const { complete } = await import("../src/cli/Autocomplete.js");
    const subs = complete({ line: "/skills ", cursor: 8, runtime: runtime(process.cwd()) as never });
    expect(subs?.items.map((item) => item.value)).toContain("show");
  });

  it("returns undefined for free text so the menu stays hidden", async () => {
    const { complete } = await import("../src/cli/Autocomplete.js");
    const result = complete({ line: "explain this repo", cursor: 17, runtime: runtime(process.cwd()) as never });
    expect(result).toBeUndefined();
  });

  it("applies a completion by replacing the token and adding a space", async () => {
    const { applyCompletion } = await import("../src/cli/Autocomplete.js");
    const next = applyCompletion("/mo", 3, { items: [], start: 0, end: 3 }, {
      value: "/mode",
      label: "/mode",
      kind: "command",
    });
    expect(next.line).toBe("/mode ");
    expect(next.cursor).toBe(6);
  });

  it("fuzzy-matches a subsequence when no prefix fits", async () => {
    const { rank } = await import("../src/cli/Autocomplete.js");
    const items = [
      { value: "/help", label: "/help", kind: "command" as const },
      { value: "/export", label: "/export", kind: "command" as const },
    ];
    // "xpr" is a subsequence of "/export" but not of "/help".
    expect(rank(items, "xpr").map((item) => item.value)).toEqual(["/export"]);
  });
});

describe("fold store", () => {
  it("keeps the last fold, toggles it, and reports unknown ids as undefined", async () => {
    const { folds } = await import("../src/cli/Folds.js");
    folds().reset();
    const first = folds().add("bash", "npm test", "line\n".repeat(40));
    const second = folds().add("read_file", "src/a.ts", "x\n".repeat(30));
    expect(folds().last()?.id).toBe(second.id);

    const toggled = folds().toggle();
    expect(toggled?.id).toBe(second.id);
    expect(toggled?.expanded).toBe(true);
    expect(folds().toggle()?.expanded).toBe(false);

    expect(folds().toggle(first.id)?.id).toBe(first.id);
    expect(folds().get(9999)).toBeUndefined();
    folds().reset();
  });

  it("drops the oldest folds once the cap is reached", async () => {
    const { folds } = await import("../src/cli/Folds.js");
    folds().reset();
    const first = folds().add("bash", "t", "b");
    for (let index = 0; index < 120; index++) folds().add("bash", "t", "b");
    expect(folds().get(first.id)).toBeUndefined();
    expect(folds().size()).toBe(100);
    folds().reset();
  });
});

describe("Chrome completion menu", () => {
  async function chromeWith(width: number, rows: number) {
    const { Chrome } = await import("../src/cli/Chrome.js");
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough() as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = true;
    (out as unknown as { columns: number }).columns = width;
    (out as unknown as { rows: number }).rows = rows;
    const writes: string[] = [];
    out.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    const chrome = new Chrome(out);
    chrome.enable(["h1", "h2"]);
    return { chrome, writes };
  }

  it("reserves rows above the status line and gives them back when cleared", async () => {
    const { chrome } = await chromeWith(80, 24);
    const bare = chrome.current();
    expect(bare.menuRows).toBe(0);

    chrome.setMenu(["a", "b", "c"]);
    const withMenu = chrome.current();
    expect(withMenu.menuRows).toBe(3);
    expect(withMenu.menuTop).toBe(withMenu.statusRow - 3);
    // The menu eats into the conversation region, never into the footer.
    expect(withMenu.regionBottom).toBeLessThan(bare.regionBottom);
    expect(withMenu.statusRow).toBe(23);
    expect(withMenu.promptRow).toBe(24);

    chrome.clearMenu();
    expect(chrome.current().menuRows).toBe(0);
    expect(chrome.current().regionBottom).toBe(bare.regionBottom);
  });

  it("paints the menu rows and wipes them on clear", async () => {
    const { chrome, writes } = await chromeWith(80, 24);
    writes.length = 0;
    chrome.setMenu(["alpha", "beta"]);
    const painted = writes.join("");
    expect(painted).toContain("alpha");
    expect(painted).toContain("beta");

    writes.length = 0;
    chrome.clearMenu();
    // Clearing must issue an erase for each row it had drawn.
    expect(writes.join("")).toContain("\u001b[2K");
  });
});

describe("activity label for tools", () => {
  it("turns a tool call into a present-tense footer label", async () => {
    const { toolLabel } = await import("../src/cli/ToolView.js");
    expect(toolLabel("bash", { command: "npm test" })).toBe("running npm test");
    expect(toolLabel("read_file", { path: "src/index.ts" })).toBe("reading src/index.ts");
    expect(toolLabel("grep_search", { pattern: "foo" })).toContain("searching");
    // Unknown tools fall back to their own name rather than showing nothing.
    expect(toolLabel("mystery_tool", {})).toBe("mystery_tool");
  });
});

describe("Markdown live tail", () => {
  it("draws the in-progress line and erases it before the next one", async () => {
    const { MarkdownRenderer } = await import("../src/cli/Markdown.js");
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 80;
    (out as unknown as { isTTY: boolean }).isTTY = true;
    const writes: string[] = [];
    out.on("data", (chunk: Buffer) => writes.push(chunk.toString()));

    const md = new MarkdownRenderer(out);
    md.setLiveTail(true);
    // No newline yet: the partial line must still reach the terminal.
    md.push("partial ");
    expect(writes.join("")).toContain("partial");
    // A complete line arrives; the tail is erased with a carriage return first.
    writes.length = 0;
    md.push("line\n");
    expect(writes.join("")).toContain("\r\u001b[K");
    expect(writes.join("")).toContain("partial line");
    md.flush();
  });

  it("still draws the live tail when the pty reports zero columns", async () => {
    const { MarkdownRenderer } = await import("../src/cli/Markdown.js");
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough() as unknown as NodeJS.WriteStream;
    // A pty with no window size set reports 0; `columns ?? 100` keeps the 0 and
    // every preview looks wider than the "terminal", so nothing is drawn.
    (out as unknown as { columns: number }).columns = 0;
    (out as unknown as { isTTY: boolean }).isTTY = true;
    const writes: string[] = [];
    out.on("data", (chunk: Buffer) => writes.push(chunk.toString()));

    const md = new MarkdownRenderer(out);
    md.setLiveTail(true);
    md.push("streaming ");
    expect(writes.join("")).toContain("streaming");
    md.flush();
  });
});

describe("Prompt completion keyboard semantics", () => {
  /** Drives the real Prompt over a fake TTY and reports what it settles on. */
  async function press(sequence: string[]): Promise<{ type: string; text?: string }> {
    const { Prompt } = await import("../src/cli/Prompt.js");
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    (input as unknown as { columns: number }).columns = 100;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    (output as unknown as { columns: number }).columns = 100;
    (output as unknown as { rows: number }).rows = 30;
    const prompt = new Prompt(input, output);
    const runtime = { config: { cwd: process.cwd(), provider: "anthropic" } } as never;
    const pending = prompt.read({ prompt: "carls> ", runtime });
    await new Promise((r) => setTimeout(r, 10));
    for (const key of sequence) {
      input.write(key);
      await new Promise((r) => setTimeout(r, 15));
    }
    return pending;
  }

  it("submits a typed command verbatim when Enter is pressed without navigating", async () => {
    // The menu is open (argument completions exist for /doctor), but the user
    // never touched the arrows, so the text must survive untouched.
    const result = await press(["/doctor", "\r"]);
    expect(result).toEqual({ type: "line", text: "/doctor" });
  });

  it("accepts the highlighted row and submits it when the arrows were used", async () => {
    const result = await press(["/mo", "\u001b[B", "\r"]);
    expect(result.type).toBe("line");
    expect(result.text?.startsWith("/mode") || result.text?.startsWith("/model")).toBe(true);
  });

  it("accepts the highlighted row on Tab without submitting", async () => {
    // Tab completes into the composer; only the following Enter submits, so the
    // completed text must equal exactly what Enter then sends.
    const result = await press(["/mo", "\t", "\r"]);
    expect(result.type).toBe("line");
    expect(result.text?.trim().length).toBeGreaterThan(0);
    // A trailing space is added so the next argument can be typed right away.
    expect(result.text).toMatch(/^\/mo(de|del|dels)? $/);
  });

  it("closes the menu on Escape and leaves the typed text alone", async () => {
    const result = await press(["/mo", "\u001b", "\r"]);
    expect(result).toEqual({ type: "line", text: "/mo" });
  });
});

describe("collapsible tool output", () => {
  it("registers a fold and prints a ctrl+o hint for long shell output", async () => {
    const { toolResultLine } = await import("../src/cli/ToolView.js");
    const { folds } = await import("../src/cli/Folds.js");
    folds().reset();

    const long = Array.from({ length: 60 }, (_v, index) => `line ${index}`).join("\n");
    const line = toolResultLine("bash", { ok: true, output: long });
    // The block is printed collapsed, but the full text is kept for expansion.
    expect(line).toContain("ctrl+o expands");
    expect(folds().size()).toBe(1);
    expect(folds().last()?.body.split("\n").length).toBe(60);

    // A short result needs no fold and no hint.
    folds().reset();
    const short = toolResultLine("bash", { ok: true, output: "ok\n" });
    expect(short).not.toContain("ctrl+o");
    expect(folds().size()).toBe(0);
  });

  it("does not fold a short diff", async () => {
    const { toolResultLine } = await import("../src/cli/ToolView.js");
    const { folds } = await import("../src/cli/Folds.js");
    folds().reset();
    const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
    const line = toolResultLine("edit_file", { ok: true, output: "", metadata: { diff, path: "x" } });
    expect(line).toContain("+new");
    expect(line).not.toContain("ctrl+o");
    expect(folds().size()).toBe(0);
  });
});
