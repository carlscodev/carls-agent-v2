import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/Config.js";
import { AgentLoop, LOOP_STALL_WARNING, isCreationRequest } from "../src/core/AgentLoop.js";
import { ContextManager } from "../src/core/ContextManager.js";
import { CostTracker } from "../src/core/CostTracker.js";
import { EvidenceTracker, evaluateEvidence, isVerificationCommand } from "../src/core/EvidenceGate.js";
import { Hooks } from "../src/core/Hooks.js";
import { detectRole, routeIntent } from "../src/core/IntentRouter.js";
import { PersistentTaskDAG } from "../src/core/PersistentTaskDAG.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { SUBAGENT_ROLES } from "../src/core/SubAgent.js";
import { buildSystemPrompt } from "../src/core/SystemPrompt.js";
import { TaskHorizonRouter, countAsks } from "../src/core/TaskHorizonRouter.js";
import { PermissionGate } from "../src/security/PermissionGate.js";
import { discoverSkillsForGoal } from "../src/skills/SkillDiscovery.js";
import { SkillRegistry } from "../src/skills/SkillRegistry.js";
import { AutoReviewSteeringClassifier } from "../src/symbiosis/SteeringClassifier.js";
import { FileWrite } from "../src/tools/FileWrite.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { ContentBlock, Message, Provider } from "../src/types/llm.js";
import type { Tool, ToolContext } from "../src/types/tools.js";
import { Logger } from "../src/utils/Logger.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "carls-hyper-agent-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Hyper-Agent SystemPrompt hardening", () => {
  it("enforces all 6 operative laws and the GATHER -> ARCHITECT -> ACT -> VERIFY workflow", () => {
    const prompt = buildSystemPrompt(loadConfig({}, dir));
    expect(prompt).toContain("LAW 1 - Execution-First MANDATE");
    expect(prompt).toContain("LAW 2 - ARCHITECTURE & CONTRACTS FIRST");
    expect(prompt).toContain("LAW 3 - ELITE VISUAL STANDARD");
    expect(prompt).toContain("LAW 4 - SKILL AUTONOMY & CONTINUOUS EVOLUTION");
    expect(prompt).toContain("LAW 5 - ROOT-CAUSE ENGINEERING & ANTI-LOOP DISCIPLINE");
    expect(prompt).toContain("LAW 6 - EMPIRICAL VERIFICATION & HONESTY GATE");
    expect(prompt).toContain("GATHER -> ARCHITECT -> ACT -> VERIFY");
    expect(prompt).toContain("FileStateCache");
    expect(prompt).toContain("delegate_task");
  });
});

describe("Hyper-Agent EvidenceGate pass/fail verification enforcement", () => {
  it("recognises Windows .cmd/.exe runners and modern linters/checkers", () => {
    for (const cmd of [
      "npm.cmd run typecheck",
      "npx.cmd vitest run",
      "biome check .",
      "ruff check src",
      "pyright",
      "cargo clippy",
      "go vet ./...",
      "deno test",
    ]) {
      expect(isVerificationCommand(cmd), cmd).toBe(true);
    }
    expect(isVerificationCommand('Write-Output "tests pass"')).toBe(false);
  });

  it("keeps pendingWrites open when verification fails and blocks a premature green claim", () => {
    const tracker = new EvidenceTracker();
    tracker.recordWrite("edit_file");
    tracker.recordVerification("npm test", false);

    expect(tracker.pendingWrites).toBe(1);
    expect(tracker.lastVerificationPassed).toBe(false);

    const redClaim = evaluateEvidence({ ...tracker.snapshot(), finalText: "Listo, todo funciona perfecto" });
    expect(redClaim.trigger).toBe(true);
    expect(redClaim.reason).toContain("npm test");
    expect(redClaim.reason).toContain("failed");

    // Honest blocker admission does not fire a redundant nudge.
    const honestBlock = evaluateEvidence({ ...tracker.snapshot(), finalText: "Falló npm test, bloqueado por dependencia" });
    expect(honestBlock.trigger).toBe(false);

    // Passing verification clears pendingWrites.
    tracker.recordVerification("npm test", true);
    expect(tracker.pendingWrites).toBe(0);
    expect(evaluateEvidence({ ...tracker.snapshot(), finalText: "Listo, todo funciona perfecto" }).trigger).toBe(false);
  });

  it("forces AgentLoop to fix and re-verify when bash verification exits non-zero", async () => {
    const logger = new Logger("error");
    const config = loadConfig({ yolo: true, maxSteps: 6, provider: "openai", model: "test-model" }, dir);
    config.apiKey = "test-key";
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const registry = new ToolRegistry();
    registry.register(new FileWrite());

    let bashAttempt = 0;
    const fakeBash: Tool<{ command: string }> = {
      name: "bash",
      description: "fake verification",
      readOnly: false,
      category: "shell",
      schema: () => ({ name: "bash", description: "fake", input_schema: { type: "object" } }),
      parse: (input) => ({ command: String((input as { command?: unknown }).command ?? "") }),
      run: async () => {
        bashAttempt += 1;
        if (bashAttempt === 1) {
          return { ok: false, output: "", error: "1 test failed", metadata: { exitCode: 1 } };
        }
        return { ok: true, output: "all tests passed", metadata: { exitCode: 0 } };
      },
    };
    registry.register(fakeBash);

    let call = 0;
    const provider: Provider = {
      name: "scripted",
      async complete() {
        call += 1;
        if (call === 1) {
          return {
            content: [{ type: "tool_use", id: "w1", name: "write_file", input: { path: "app.ts", content: "broken" } }],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        if (call === 2) {
          return {
            content: [{ type: "tool_use", id: "b1", name: "bash", input: { command: "npm test" } }],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        if (call === 3) {
          // Model lies and claims success despite bash failing on call 2!
          return {
            content: [{ type: "text", text: "Listo, ya quedó arreglado y funcionando." }],
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        if (call === 4) {
          return {
            content: [{ type: "tool_use", id: "b2", name: "bash", input: { command: "npm test" } }],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return {
          content: [{ type: "text", text: "Verificado en verde con npm test." }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const baseCtx: Omit<ToolContext, "signal"> = { cwd: dir, config, session, logger };
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
      toolContext: baseCtx,
    });

    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "fix app.ts" }] }];
    const result = await loop.run(history, "fix app.ts", { silent: true });

    expect(result.stoppedReason).toBe("completed");
    expect(bashAttempt).toBe(2);
    expect(call).toBe(5);
    expect(result.finalText).toContain("Verificado en verde");
  });
});

describe("Hyper-Agent Anti-Loop stall detector & live turn injections", () => {
  it("appends LOOP_STALL_WARNING when an identical tool call fails twice in a row", async () => {
    const logger = new Logger("error");
    const config = loadConfig({ yolo: true, maxSteps: 5, provider: "openai", model: "test-model" }, dir);
    config.apiKey = "test-key";
    const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
    const registry = new ToolRegistry();

    const failingEdit: Tool<{ path: string; old_str: string }> = {
      name: "edit_file",
      description: "always fails on missing old_str",
      readOnly: false,
      category: "write",
      schema: () => ({ name: "edit_file", description: "fake", input_schema: { type: "object" } }),
      parse: (input) => ({
        path: String((input as { path?: unknown }).path ?? ""),
        old_str: String((input as { old_str?: unknown }).old_str ?? ""),
      }),
      run: async () => ({ ok: false, output: "", error: "old_string not found in file" }),
    };
    registry.register(failingEdit);

    const observedMessages: Message[][] = [];
    const observedSystems: string[] = [];
    let call = 0;
    const provider: Provider = {
      name: "scripted",
      async complete(args) {
        call += 1;
        observedSystems.push(args.system);
        observedMessages.push(args.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        if (call === 1 || call === 2) {
          return {
            content: [
              {
                type: "tool_use",
                id: `e${call}`,
                name: "edit_file",
                input: { old_str: "missing()", path: "x.ts" },
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return {
          content: [{ type: "text", text: "Bloqueado: old_string no existe en x.ts." }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const dag = new PersistentTaskDAG(join(dir, ".carls", "state"), "Migrate auth", [
      {
        id: "n1",
        title: "Update contracts",
        dependencies: [],
        status: "pending",
        acceptanceCriteria: "types compile",
        files: ["x.ts"],
        verifyCommands: ["npm run typecheck"],
        retryCount: 0,
      },
    ]);
    const baseCtx: Omit<ToolContext, "signal"> = { cwd: dir, config, session, logger, dag };
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
      systemPrompt: "base-system",
      toolContext: baseCtx,
      getOperatorRules: () => ["Never touch legacy/auth-v1.ts", "Always run vitest"],
    });

    const goal = "arregla el bug en x.ts";
    const history: Message[] = [{ role: "user", content: [{ type: "text", text: goal }] }];
    await loop.run(history, goal, { silent: true });

    // Operator rules and active long-horizon DAG guidance are injected into the live turn prompt.
    expect(observedSystems[0]).toContain("[Operator rules in force");
    expect(observedSystems[0]).toContain("Never touch legacy/auth-v1.ts");
    expect(observedSystems[0]).toContain("[Horizon: LONG]");

    // First failure does NOT yet carry LOOP_STALL_WARNING; second identical failure DOES.
    const snapshotAfterFirst = observedMessages[1] ?? [];
    const firstResult = snapshotAfterFirst
      .flatMap((m) => m.content)
      .find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result" && b.tool_use_id === "e1");
    expect(firstResult?.content).not.toContain(LOOP_STALL_WARNING);

    const snapshotAfterSecond = observedMessages[2] ?? [];
    const secondResult = snapshotAfterSecond
      .flatMap((m) => m.content)
      .find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result" && b.tool_use_id === "e2");
    expect(secondResult?.content).toContain(LOOP_STALL_WARNING);
  });
});

describe("Hyper-Agent IntentRouter, SkillDiscovery hints & bilingual routers", () => {
  it("detects Security and DevOps expert roles and maps them to real builtin skills", () => {
    expect(detectRole("haz una auditoría de seguridad OWASP y vulnerabilidades XSS")).toBe(
      "Security / Reliability Auditor",
    );
    expect(detectRole("configura docker, kubernetes y el pipeline de github actions")).toBe(
      "DevOps / Cloud Infrastructure Architect",
    );

    const registry = new SkillRegistry(dir);
    const secDecision = routeIntent("realiza una auditoría de seguridad completa del sistema");
    for (const hint of secDecision.skillHints) {
      expect(registry.get(hint), `missing builtin skill ${hint}`).toBeDefined();
    }

    const devopsDecision = routeIntent("construye toda la infraestructura docker y kubernetes");
    expect(devopsDecision.profile).toBe("HEAVY_ARCHITECT_POWER_MODE");
    expect(devopsDecision.role).toBe("DevOps / Cloud Infrastructure Architect");
    for (const hint of devopsDecision.skillHints) {
      expect(registry.get(hint), `missing builtin skill ${hint}`).toBeDefined();
    }

    // SkillDiscovery boosts hinted skills even when the goal wording is terse.
    const boosted = discoverSkillsForGoal(registry, "revisa esto", { hints: ["security-review"] });
    expect(boosted.relevant.map((h) => h.skill.name)).toContain("security-review");
  });

  it("recognises expanded Spanish creation verbs", () => {
    expect(isCreationRequest("implementa un módulo de pagos")).toBe(true);
    expect(isCreationRequest("levanta un servidor HTTP")).toBe(true);
    expect(isCreationRequest("diseña una landing page minimalista")).toBe(true);
  });

  it("routes Spanish multi-step horizons accurately in TaskHorizonRouter", () => {
    const router = new TaskHorizonRouter();
    expect(router.decide({ goal: "¿dónde está definido el router?" }).horizon).toBe("short");

    const spanishMulti = [
      "Primero refactoriza el módulo de configuración.",
      "Después migra todos los archivos que lo consumen.",
      "Finalmente ejecuta de punta a punta todo el proyecto y arregla lo que falle.",
    ].join(" ");
    expect(countAsks(spanishMulti)).toBeGreaterThanOrEqual(3);
    expect(router.decide({ goal: spanishMulti }).horizon).toBe("long");
  });

  it("classifies Spanish mid-run steering without confusing 'para' preposition with stop", () => {
    const classifier = new AutoReviewSteeringClassifier();

    expect(classifier.classify("detente").intent).toBe("stop");
    expect(classifier.classify("para ahora").intent).toBe("stop");
    expect(classifier.classify("cancela todo").intent).toBe("stop");

    // Preposition "para" must NOT abort the turn — it is an ordinary steering instruction!
    const steerPrep = classifier.classify("ajusta el diseño para pantallas móviles");
    expect(steerPrep.intent).toBe("steer");
    expect(steerPrep.forward).toBe(true);

    expect(classifier.classify("no toques la carpeta dist").intent).toBe("reject");
    expect(classifier.classify("no uses axios, en lugar de eso usa fetch nativo").intent).toBe("correct");
    expect(classifier.classify("no hay problema, continúa").intent).toBe("approve");
    expect(classifier.classify("perfecto, sigue adelante").intent).toBe("approve");
    expect(classifier.classify("¿por qué cambiaste ese archivo?").intent).toBe("question");

    // Sub-agent budgets preserve auditor > planner invariant.
    expect(SUBAGENT_ROLES.auditor.maxSteps).toBeGreaterThan(SUBAGENT_ROLES.planner.maxSteps);
  });
});
