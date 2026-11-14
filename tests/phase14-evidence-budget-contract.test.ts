import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EvidenceTracker,
  EVIDENCE_CORRECTION,
  evaluateEvidence,
  isVerificationCommand,
} from "../src/core/EvidenceGate.js";
import { applyToolTokenBudget, budgetCategoryFor, tokenBudgetFor } from "../src/core/ToolTokenBudget.js";
import { CostTracker } from "../src/core/CostTracker.js";
import {
  buildSubAgentContract,
  parseSubAgentContract,
} from "../src/subagents/SubAgentContract.js";
import { archiveSkill, detectDuplicates, promoteSkill } from "../src/skills/SkillCurator.js";
import { SkillGraph } from "../src/skills/SkillEvolution.js";
import type { Skill } from "../src/skills/SkillLoader.js";
import { estimateTokens } from "../src/utils/tokens.js";
import { AgentLoop } from "../src/core/AgentLoop.js";
import { EventBus } from "../src/core/EventBus.js";
import { FileWrite } from "../src/tools/FileWrite.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { ContextManager } from "../src/core/ContextManager.js";
import { Hooks } from "../src/core/Hooks.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { loadConfig } from "../src/config/Config.js";
import { Logger } from "../src/utils/Logger.js";
import type { Message } from "../src/types/llm.js";
import type { Tool, ToolContext } from "../src/types/tools.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "carls-phase14-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function skill(name: string, body: string, path: string, source: Skill["source"] = "project"): Skill {
  return { name, description: `${name} procedure`, tags: [], path, source, body };
}

describe("Phase 14 EvidenceGate", () => {
  it("accepts real verification commands and rejects convincing echoes", () => {
    for (const command of [
      "npm test",
      "npm run typecheck",
      "cd app && npm test -- --run",
      "pnpm build",
      "npx vitest run",
      "tsc --noEmit",
      "pytest -q",
      "python -m pytest",
      "cargo test",
      "go test ./...",
      "lsp diagnostics",
    ]) {
      expect(isVerificationCommand(command)).toBe(true);
    }
    for (const command of [
      'echo "tests pass"',
      "echo npm test",
      "printf 'tsc'",
      "true",
      "cat package.json",
      "echo 'cargo test'",
    ]) {
      expect(isVerificationCommand(command)).toBe(false);
    }
  });

  it("fires only after an unverified write and a success claim", () => {
    const tracker = new EvidenceTracker();
    tracker.recordWrite("write_file");
    expect(tracker.pendingWrites).toBe(1);
    expect(evaluateEvidence({ ...tracker.snapshot(), finalText: "Listo, ya funciona" }).trigger).toBe(true);
    expect(evaluateEvidence({ ...tracker.snapshot(), finalText: "No puedo, está bloqueado" }).trigger).toBe(false);

    tracker.recordVerification("npm test");
    expect(evaluateEvidence({ ...tracker.snapshot(), finalText: "Listo, ya funciona" }).trigger).toBe(false);

    tracker.recordWrite("edit_file");
    expect(tracker.pendingWrites).toBe(1);
    expect(evaluateEvidence({ ...tracker.snapshot(), finalText: "done" }).trigger).toBe(true);
  });

  it("injects the corrective message into the turn and emits evidence.gate", async () => {
    const logger = new Logger("error");
    const config = loadConfig({ yolo: true, maxSteps: 5, provider: "openai", model: "test-model" }, dir);
    config.apiKey = "test-key";
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const registry = new ToolRegistry();
    registry.register(new FileWrite());

    const fakeBash: Tool<{ command: string }> = {
      name: "bash",
      description: "fake verification",
      readOnly: false,
      category: "shell",
      schema: () => ({ name: "bash", description: "fake", input_schema: { type: "object" } }),
      parse: (input) => ({ command: String((input as { command?: unknown }).command ?? "") }),
      run: async () => ({ ok: true, output: "tests pass", metadata: { exitCode: 0 } }),
    };
    registry.register(fakeBash);

    const systems: string[] = [];
    const snapshots: Message[][] = [];
    let call = 0;
    const provider: import("../src/types/llm.js").Provider = {
      name: "scripted",
      async complete(args) {
        call += 1;
        systems.push(args.system);
        snapshots.push(args.messages.map((message) => ({ role: message.role, content: [...message.content] })));
        if (call === 1) {
          return {
            content: [
              { type: "tool_use", id: "w1", name: "write_file", input: { path: "a.txt", content: "x" } },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        if (call === 2) {
          return { content: [{ type: "text", text: "Listo, ya funciona" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
        }
        if (call === 3) {
          return {
            content: [{ type: "tool_use", id: "v1", name: "bash", input: { command: "npm test" } }],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return { content: [{ type: "text", text: "Listo, verificado" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    const events = new EventBus();
    const gateEvents: string[] = [];
    events.on("evidence.gate", (event) => gateEvents.push(event.reason));

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

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "arregla el bug" }] }];
    const result = await loop.run(history, "arregla el bug", { silent: true });

    expect(result.stoppedReason).toBe("completed");
    expect(result.finalText).toContain("verificado");
    expect(call).toBe(4);
    expect(gateEvents).toHaveLength(1);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);

    // The correction is appended after the gate fires on call 2, so the model
    // sees it on its next request (call 3).
    const nextCall = snapshots[2]?.flatMap((message) => message.content) ?? [];
    expect(nextCall.some((block) => block.type === "text" && block.text === EVIDENCE_CORRECTION)).toBe(true);
  });
});

describe("Phase 14 ToolTokenBudget", () => {
  it("maps tools to the correct category and ceiling", () => {
    expect(budgetCategoryFor("mcp__demo__echo", "read")).toBe("mcp");
    expect(budgetCategoryFor("bash", "shell")).toBe("bash");
    expect(budgetCategoryFor("write_file", "write")).toBe("write");
    expect(budgetCategoryFor("read_file", "read")).toBe("read");
    expect(tokenBudgetFor({ toolName: "read_file" })).toBe(4000);
    expect(tokenBudgetFor({ toolName: "bash" })).toBe(3000);
    expect(tokenBudgetFor({ toolName: "mcp__x__y" })).toBe(3500);
    expect(tokenBudgetFor({ toolName: "write_file", category: "write" })).toBe(2000);
  });

  it("cuts a large observation to head + tail with an actionable marker", () => {
    const lines = Array.from({ length: 240 }, (_value, index) => `line ${index}: ${"x".repeat(80)}`);
    const text = lines.join("\n");
    const result = applyToolTokenBudget(text, { toolName: "read_file", maxTokens: 200 });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("line 0:");
    expect(result.text).toContain("line 239:");
    expect(result.text).toContain("read_file (start_line/end_line)");
    expect(result.text).toContain("tokens omitted");
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.omittedTokens).toBeGreaterThan(0);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("leaves a small observation untouched", () => {
    const result = applyToolTokenBudget("small output", { toolName: "read_file", maxTokens: 200 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("small output");
  });

  it("cuts a single-line observation that has no middle line to drop", () => {
    // A minified file, a one-line JSON blob or a one-row error: the line-based
    // pass finds no middle to remove, so the whole payload would reach the model.
    const text = "x".repeat(200_000);
    const result = applyToolTokenBudget(text, { toolName: "bash", maxTokens: 3000 });

    expect(result.truncated).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(result.budgetTokens);
    // The head and the tail are both preserved; only the middle is dropped.
    expect(result.text.startsWith("x")).toBe(true);
    expect(result.text.endsWith("x")).toBe(true);
    expect(result.text).toContain("characters");
    expect(result.text).toContain("tokens omitted");
    expect(result.omittedTokens).toBeGreaterThan(0);
  });

  it("cuts an oversized two-line observation by characters, not lines", () => {
    const text = `${"a".repeat(100_000)}\n${"b".repeat(100_000)}`;
    const result = applyToolTokenBudget(text, { toolName: "bash", maxTokens: 3000 });

    expect(result.truncated).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(result.budgetTokens);
    expect(result.text.startsWith("a")).toBe(true);
    expect(result.text.endsWith("b")).toBe(true);
  });

  it("still returns a short single line untouched", () => {
    const result = applyToolTokenBudget("one short line", { toolName: "read_file", maxTokens: 200 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("one short line");
  });
});

describe("Phase 14 SubAgentContract and cost forwarding", () => {
  it("keeps the model half and the harness-observed half separate", () => {
    const contract = buildSubAgentContract(
      { summary: "found it", findings: ["one"], relevantFiles: ["a.ts"], suggestedCommands: ["npm test"] },
      {
        filesModified: [],
        commandsExecuted: ["rg -n foo"],
        verificationPassed: true,
        verificationEvidence: ["npm test: ok"],
        tokensUsed: 123,
        durationMs: 456,
      },
    );
    expect(contract.verificationPassed).toBe(true);
    expect(contract.tokensUsed).toBe(123);
    expect(parseSubAgentContract(JSON.stringify(contract))).toEqual(contract);
  });

  it("forwards child usage to the parent while preserving the breakdown", () => {
    const parent = new CostTracker("gpt-4o");
    const child = parent.child("explorer: map the repo");
    child.add({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });

    const snapshot = parent.snapshot();
    expect(snapshot.inputTokens).toBe(100);
    expect(snapshot.outputTokens).toBe(50);
    expect(snapshot.cacheReadTokens).toBe(20);
    expect(snapshot.children?.[0]?.label).toBe("explorer: map the repo");
    expect(snapshot.children?.[0]?.cost.inputTokens).toBe(100);
  });
});

describe("Phase 14 SkillCurator", () => {
  it("detects duplicate skills with Jaccard similarity", () => {
    const body = "Read the target file. Apply the change. Verify the result with the test command and report it.";
    const duplicate = "Read the target file. Apply the change. Verify the result with the test command and report it clearly.";
    const different = "Create a Kubernetes deployment with a service, ingress and resource limits.";
    const pairs = detectDuplicates([
      skill("a", body, join(dir, "a.md")),
      skill("b", duplicate, join(dir, "b.md")),
      skill("c", different, join(dir, "c.md")),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe("a");
    expect(pairs[0]?.b).toBe("b");
    expect(pairs[0]?.similarity).toBeGreaterThanOrEqual(0.75);
  });

  it("promotes only a proven project skill", async () => {
    const path = join(dir, "shared.md");
    await writeFile(path, "---\nname: shared\n---\n\nBody.\n", "utf8");
    const shared = skill("shared", "Body.", path);
    const target = join(dir, "user-skills");

    expect(promoteSkill(shared, target, { uses: 2 }).ok).toBe(false);
    const promoted = promoteSkill(shared, target, { uses: 3 });
    expect(promoted.ok).toBe(true);
    expect(existsSync(join(target, "shared", "SKILL.md"))).toBe(true);
  });

  it("archives reversibly and refuses an active dependent", async () => {
    const leafPath = join(dir, "leaf.md");
    const rootPath = join(dir, "root.md");
    await writeFile(leafPath, "---\nname: leaf\ndescription: leaf\n---\n\nLeaf body.\n", "utf8");
    await writeFile(rootPath, "---\nname: root\ndescription: root\nrequires: [leaf]\n---\n\nRoot body.\n", "utf8");
    const leaf = skill("leaf", "Leaf body.", leafPath);
    const root = skill("root", "Root body.", rootPath);
    const graph = new SkillGraph([leaf, root]);

    const blocked = archiveSkill(leaf, graph);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("root");

    const standalonePath = join(dir, "standalone.md");
    await writeFile(standalonePath, "---\nname: standalone\ndescription: standalone\n---\n\nStandalone body.\n", "utf8");
    const standalone = skill("standalone", "Standalone body.", standalonePath);
    const archived = archiveSkill(standalone, new SkillGraph([standalone]));
    expect(archived.ok).toBe(true);
    expect(existsSync(standalonePath)).toBe(false);
    expect(existsSync(`${standalonePath}.disabled`)).toBe(true);
  });
});
