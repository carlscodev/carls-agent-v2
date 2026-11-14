import type { SubAgent, SubAgentRole } from "./SubAgent.js";
import { parseSubAgentContract } from "../subagents/SubAgentContract.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import type { EventBus } from "./EventBus.js";

/**
 * Runs several sub-agents at once.
 *
 * One sub-agent is useful; a fleet of them is what a large refactoring needs,
 * because the expensive part of "where is this used?" is the reading, and reading
 * is embarrassingly parallel. The pool keeps the parent's context small for the
 * same reason a single sub-agent does: each child explores in its own window and
 * only its structured report comes back.
 *
 * Two properties keep it honest:
 *
 * - A child that fails is reported as a failure, never silently dropped, and the
 *   other children still finish.
 * - The parent sees one block, in request order, so the result is stable and easy
 *   to diff between runs.
 */

export interface SubAgentTask {
  goal: string;
  role: SubAgentRole;
}

export interface SubAgentOutcome {
  goal: string;
  role: SubAgentRole;
  ok: boolean;
  summary: string;
  findings: string[];
  relevantFiles: string[];
  suggestedCommands: string[];
  filesModified?: string[];
  commandsExecuted?: string[];
  verificationPassed?: boolean;
  verificationEvidence?: string[];
  tokensUsed?: number;
  durationMs?: number;
  error?: string;
}

export interface SubAgentPoolOptions {
  /** Children in flight at once. Each is a full model conversation. */
  concurrency?: number;
  /** Hard cap on tasks per call, so one request cannot fan out without bound. */
  maxTasks?: number;
  /** Optional telemetry bus; the HUD reads active children from it. */
  events?: EventBus;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_TASKS = 6;

export class SubAgentPool {
  private readonly agent: SubAgent;
  private readonly concurrency: number;
  private readonly maxTasks: number;
  private readonly events?: EventBus;
  private active = 0;

  constructor(agent: SubAgent, options: SubAgentPoolOptions = {}) {
    this.agent = agent;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxTasks = Math.max(1, options.maxTasks ?? DEFAULT_MAX_TASKS);
    if (options.events !== undefined) this.events = options.events;
  }

  /** How many tasks a single call will accept before refusing the rest. */
  get limit(): number {
    return this.maxTasks;
  }

  /** Children currently running, for the live HUD. */
  get activeCount(): number {
    return this.active;
  }

  /**
   * Runs every task and returns one outcome per task, in request order. Never
   * throws: a child's failure becomes an outcome with `ok: false`.
   */
  async run(tasks: readonly SubAgentTask[]): Promise<SubAgentOutcome[]> {
    const accepted = tasks.slice(0, this.maxTasks);
    return mapWithConcurrency(accepted, this.concurrency, async (task) => {
      this.active++;
      this.events?.emit("subagent.status", {
        role: task.role,
        goal: task.goal,
        phase: "start",
        at: Date.now(),
      });
      try {
        const raw = await this.agent.run(task.goal, task.role, (detail) => {
          this.events?.emit("subagent.status", {
            role: task.role,
            goal: task.goal,
            phase: "progress",
            detail,
            at: Date.now(),
          });
        });
        const report = parseSubAgentContract(raw);
        this.events?.emit("subagent.status", {
          role: task.role,
          goal: task.goal,
          phase: "done",
          ok: true,
          at: Date.now(),
        });
        return {
          goal: task.goal,
          role: task.role,
          ok: true,
          summary: report.summary,
          findings: report.findings,
          relevantFiles: report.relevantFiles,
          suggestedCommands: report.suggestedCommands,
          filesModified: report.filesModified,
          commandsExecuted: report.commandsExecuted,
          verificationPassed: report.verificationPassed,
          verificationEvidence: report.verificationEvidence,
          tokensUsed: report.tokensUsed,
          durationMs: report.durationMs,
        } satisfies SubAgentOutcome;
      } catch (error) {
        this.events?.emit("subagent.status", {
          role: task.role,
          goal: task.goal,
          phase: "failed",
          ok: false,
          at: Date.now(),
        });
        return {
          goal: task.goal,
          role: task.role,
          ok: false,
          summary: "",
          findings: [],
          relevantFiles: [],
          suggestedCommands: [],
          error: (error as Error).message,
        } satisfies SubAgentOutcome;
      } finally {
        this.active = Math.max(0, this.active - 1);
      }
    });
  }
}

/**
 * Renders pool outcomes as the text the parent model reads. The per-child format
 * is deliberately flat: the parent needs the facts, not a nested structure it has
 * to parse back out of its own context.
 */
export function formatOutcomes(outcomes: readonly SubAgentOutcome[]): string {
  if (outcomes.length === 0) return "No sub-agent tasks were run.";
  const blocks = outcomes.map((outcome, index) => {
    const header = `[${index + 1}] ${outcome.role} · ${outcome.goal}`;
    if (!outcome.ok) return `${header}\n  FAILED: ${outcome.error ?? "unknown error"}`;
    const parts = [header, `  ${outcome.summary || "(no summary)"}`];
    if (outcome.verificationPassed !== undefined) {
      parts.push(`  observed: ${outcome.verificationPassed ? "verification passed" : "no verification"} · ${outcome.durationMs ?? 0}ms · ${outcome.tokensUsed ?? 0} tokens`);
    }
    if (outcome.findings.length > 0) {
      parts.push(`  findings:\n${outcome.findings.map((f) => `    - ${f}`).join("\n")}`);
    }
    if (outcome.relevantFiles.length > 0) {
      parts.push(`  files: ${outcome.relevantFiles.join(", ")}`);
    }
    if (outcome.suggestedCommands.length > 0) {
      parts.push(`  commands: ${outcome.suggestedCommands.join(" | ")}`);
    }
    return parts.join("\n");
  });
  return blocks.join("\n\n");
}
