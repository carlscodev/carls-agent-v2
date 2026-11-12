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

const SUBAGENT_INSTRUCTIONS = `You are an isolated exploration sub-agent. You have READ-ONLY tools.
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

  async run(goal: string): Promise<string> {
    const maxSteps = this.deps.maxSteps ?? 15;
    const registry = this.deps.registry.readOnlyOnly();
    const loop = this.deps.createLoop(registry, maxSteps);

    const history: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: `${SUBAGENT_INSTRUCTIONS}\n\nGoal: ${goal}` }],
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
