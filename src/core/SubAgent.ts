import type { Message } from "../types/llm.js";
import type { AgentRunResult } from "../types/agent.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentLoop } from "./AgentLoop.js";

export interface SubAgentDeps {
  /** Factory that builds a loop already wired to the read-only tool set. */
  createLoop: (registry: ToolRegistry, maxSteps: number) => AgentLoop;
  registry: ToolRegistry;
  maxSteps?: number;
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
      "Report the files and symbols that matter, the call path between them, and anything surprising. Do not propose changes.",
    maxSteps: 15,
  },
  planner: {
    description: "Turn a goal into an ordered, concrete plan.",
    instruction:
      "Produce an ordered list of concrete steps, each naming the file and symbol it touches, plus the risks and the order they must happen in. Do not write code.",
    maxSteps: 12,
  },
  auditor: {
    description: "Hunt for bugs, security issues and dead code.",
    instruction:
      "Look for real defects: incorrect edge cases, resource leaks, unhandled errors, unsafe input handling and unreachable code. Cite file and line. Rank by severity and do not report style preferences.",
    maxSteps: 20,
  },
  tester: {
    description: "Find how the project is verified and what is untested.",
    instruction:
      "Identify the test command, the existing coverage of the area under study, and the specific cases that are missing. Name the files a new test would live in.",
    maxSteps: 15,
  },
};

const SUBAGENT_CONTRACT = `You are an isolated sub-agent. You have READ-ONLY tools.
Investigate the goal thoroughly, then stop. Do not attempt edits.
When done, reply with a single JSON object and nothing else, shaped exactly:
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

  async run(goal: string, role: SubAgentRole = "explorer"): Promise<string> {
    const spec = SUBAGENT_ROLES[role];
    const maxSteps = this.deps.maxSteps ?? spec.maxSteps;
    const registry = this.deps.registry.readOnlyOnly();
    const loop = this.deps.createLoop(registry, maxSteps);

    const history: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: SubAgent.instructions(goal, role) }],
      },
    ];

    let result: AgentRunResult;
    try {
      result = await loop.run(history, goal, { silent: true });
    } catch (error) {
      return JSON.stringify({
        summary: `Sub-agent failed: ${(error as Error).message}`,
        findings: [],
        relevantFiles: [],
        suggestedCommands: [],
      } satisfies SubAgentReport);
    }

    const parsed = parseReport(result.finalText);
    return JSON.stringify(parsed);
  }
}

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
