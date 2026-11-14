import type { Message } from "../types/llm.js";
import type { AgentRunResult } from "../types/agent.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentLoop } from "./AgentLoop.js";
import { CostTracker } from "./CostTracker.js";
import {
  buildSubAgentContract,
  parseSubAgentContract,
  type SubAgentContractResult,
} from "../subagents/SubAgentContract.js";

export interface SubAgentDeps {
  /** Factory that builds a loop already wired to the read-only tool set. */
  createLoop: (registry: ToolRegistry, maxSteps: number, costTracker: CostTracker) => AgentLoop;
  registry: ToolRegistry;
  maxSteps?: number;
  /** Parent cost tracker; the child forwards its usage here. */
  costTracker?: CostTracker;
}

export interface SubAgentReport {
  summary: string;
  findings: string[];
  relevantFiles: string[];
  suggestedCommands: string[];
}

/**
 * What a sub-agent is for. The role only changes the instructions and the step
 * budget; every role stays read-only, so a pool of them can never mutate the
 * workspace while the parent is reasoning about it.
 */
export type SubAgentRole = "explorer" | "planner" | "auditor" | "tester";

export interface RoleSpec {
  description: string;
  /** Extra instruction appended to the shared contract. */
  instruction: string;
  /** Step budget; a broad audit needs more room than a single lookup. */
  maxSteps: number;
}

export const SUBAGENT_ROLES: Record<SubAgentRole, RoleSpec> = {
  explorer: {
    description: "Map where things live and how they connect.",
    instruction:
      "Batch grep_search, glob_files, repo_map and read_file in parallel. Report the exact file paths, exported symbols, call graph between them, and architectural invariants or surprises. Do not propose edits.",
    maxSteps: 16,
  },
  planner: {
    description: "Turn a goal into an ordered, concrete plan.",
    instruction:
      "Inspect types/contracts and call sites first. Produce an ordered list of atomic steps (contracts -> core -> adapters/UI -> tests), each naming the exact file, symbol, invariants and failure risks. Do not write code.",
    maxSteps: 14,
  },
  auditor: {
    description: "Hunt for bugs, security issues and dead code.",
    instruction:
      "Hunt for real, high-signal defects: broken invariants, race conditions, off-by-one/edge-case bugs, resource leaks, swallowed errors, injection/traversal flaws, and unreachable code. Cite exact file:line, rank by severity, and omit stylistic nitpicks.",
    maxSteps: 22,
  },
  tester: {
    description: "Find how the project is verified and what is untested.",
    instruction:
      "Identify the exact test/typecheck/lint commands, map existing coverage and test helpers for the target module, and list concrete missing edge-case scenarios plus the exact test file where they belong.",
    maxSteps: 16,
  },
};

const SUBAGENT_CONTRACT = `You are an isolated specialist sub-agent with READ-ONLY tools.
Batch independent read_file, multi_read, grep_search, glob_files and repo_map calls in parallel to minimise turns.
Verify every claim against actual source lines; never guess file paths or symbol names, and never attempt edits.
When finished, reply with a single valid JSON object and nothing else, shaped exactly:
{"summary": string, "findings": string[], "relevantFiles": string[], "suggestedCommands": string[]}`;

/**
 * Runs a nested, ephemeral agent loop. Its conversation is discarded; only the
 * structured conclusion travels back to the parent, keeping the parent's
 * context window lean and its prompt cache stable.
 */
export class SubAgent {
  private readonly deps: SubAgentDeps;

  constructor(deps: SubAgentDeps) {
    this.deps = deps;
  }

  /** Builds the instruction block for a role; exported for the pool and tests. */
  static instructions(goal: string, role: SubAgentRole): string {
    const spec = SUBAGENT_ROLES[role];
    return `${SUBAGENT_CONTRACT}\n\nRole: ${role}. ${spec.instruction}\n\nGoal: ${goal}`;
  }

  async run(
    goal: string,
    role: SubAgentRole = "explorer",
    onProgress?: (detail: string) => void,
  ): Promise<string> {
    const spec = SUBAGENT_ROLES[role];
    const maxSteps = this.deps.maxSteps ?? spec.maxSteps;
    const registry = this.deps.registry.readOnlyOnly();
    // Each child keeps its own breakdown and forwards the same usage to the
    // parent, so the session total is right without losing which child spent it.
    const childCost = this.deps.costTracker?.child(`${role}: ${goal.slice(0, 40)}`) ?? new CostTracker("unknown");
    const loop = this.deps.createLoop(registry, maxSteps, childCost);
    const startedAt = Date.now();

    const history: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: SubAgent.instructions(goal, role) }],
      },
    ];

    let result: AgentRunResult;
    try {
      result = await loop.run(history, goal, {
        silent: true,
        ...(onProgress !== undefined
          ? {
              onStep: (step: number, max: number) => onProgress(`paso ${step}/${max}`),
              onToolStart: (name: string) => onProgress(name),
            }
          : {}),
      });
    } catch (error) {
      return JSON.stringify(
        buildSubAgentContract(
          {
            summary: `Sub-agent failed: ${(error as Error).message}`,
            findings: [],
            relevantFiles: [],
            suggestedCommands: [],
          },
          {
            filesModified: [],
            commandsExecuted: [],
            verificationPassed: false,
            verificationEvidence: [],
            tokensUsed: 0,
            durationMs: Date.now() - startedAt,
          },
        ),
      );
    }

    const parsed = parseReport(result.finalText);
    const usage = childCost.snapshot();
    const observed = {
      filesModified: [] as string[],
      commandsExecuted: [] as string[],
      verificationPassed: false,
      verificationEvidence: [] as string[],
      tokensUsed: usage.inputTokens + usage.outputTokens,
      durationMs: Date.now() - startedAt,
    };
    return JSON.stringify(buildSubAgentContract(parsed, observed));
  }
}

/** Re-exported so callers can parse a pool payload through the same contract. */
export type { SubAgentContractResult };
export { parseSubAgentContract };

export function parseReport(text: string): SubAgentReport {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<SubAgentReport>;
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
        relevantFiles: Array.isArray(parsed.relevantFiles) ? parsed.relevantFiles.map(String) : [],
        suggestedCommands: Array.isArray(parsed.suggestedCommands)
          ? parsed.suggestedCommands.map(String)
          : [],
      };
    } catch {
      // fall through to plain-text wrapping
    }
  }
  return {
    summary: text.trim().slice(0, 4000),
    findings: [],
    relevantFiles: [],
    suggestedCommands: [],
  };
}
