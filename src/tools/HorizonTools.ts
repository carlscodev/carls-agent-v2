import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { PersistentTaskDAG } from "../core/PersistentTaskDAG.js";
import { describeSnapshot } from "../core/TaskHorizonRouter.js";

/**
 * Tools for the persisted plan.
 *
 * The model is what writes a plan, because only it can read a request and know
 * what the steps are. These tools are the mechanical half: they record the plan,
 * enforce that a node cannot be marked done without passing verification, and
 * keep the file current so a new process can pick the work up.
 */

const nodeSchema = z.object({
  title: z.string().describe("What this step achieves, in one line."),
  dependencies: z.array(z.string()).optional().describe("Ids of nodes that must complete first."),
  acceptanceCriteria: z.string().optional().describe("What must be true for this node to count as done."),
  files: z.array(z.string()).optional().describe("Files this node is expected to touch."),
  verifyCommands: z.array(z.string()).optional().describe("Commands that must exit 0 for this node to pass."),
});

function requireDag(ctx: ToolContext): PersistentTaskDAG {
  if (ctx.dag === undefined) {
    throw new Error("No task graph is active for this session.");
  }
  return ctx.dag;
}

export class PlanTask implements Tool<{ objective: string; nodes: z.infer<typeof nodeSchema>[] }> {
  readonly name = "plan_task";
  readonly description =
    "Record a multi-step plan as a persistent task graph. Use this for work that will span more than a few turns or that must survive a restart. Each node needs a title and, ideally, acceptance criteria. Replaces any previous plan.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaObject = z.object({
    objective: z.string().describe("The overall goal this plan achieves."),
    nodes: z.array(nodeSchema).min(1).describe("Ordered steps. Use dependencies to express real ordering."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): { objective: string; nodes: z.infer<typeof nodeSchema>[] } {
    return this.schemaObject.parse(input);
  }

  async run(input: { objective: string; nodes: z.infer<typeof nodeSchema>[] }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const dag = requireDag(ctx);
      dag.plan(input.objective, input.nodes);
      return {
        ok: true,
        output: `Plan recorded with ${input.nodes.length} node(s).\n${formatDag(dag)}\nState file: ${dag.statePath}`,
      };
    } catch (error) {
      return { ok: false, output: "", error: (error as Error).message };
    }
  }
}

export class AdvanceTask implements Tool<{ node_id: string; status: "running" | "verifying" | "completed" | "failed" | "rolled_back"; detail?: string | undefined }> {
  readonly name = "advance_task";
  readonly description =
    "Move a node of the active plan to a new status. A node must pass through `verifying` before it can be `completed`; mark it `failed` with a detail explaining why so the same attempt is not repeated. Use `rolled_back` when a failed node's changes were reverted.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaObject = z.object({
    node_id: z.string().describe("Node id from the plan, e.g. n1."),
    status: z.enum(["running", "verifying", "completed", "failed", "rolled_back"]),
    detail: z.string().optional().describe("Why it failed, when the status is failed."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): { node_id: string; status: "running" | "verifying" | "completed" | "failed" | "rolled_back"; detail?: string | undefined } {
    return this.schemaObject.parse(input);
  }

  async run(
    input: { node_id: string; status: "running" | "verifying" | "completed" | "failed" | "rolled_back"; detail?: string | undefined },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const dag = requireDag(ctx);
      const node = dag.setStatus(input.node_id, input.status, input.detail);
      return {
        ok: true,
        output: `${node.id} is now ${node.status}.\n${formatDag(dag)}`,
        metadata: { status: node.status, retryCount: node.retryCount },
      };
    } catch (error) {
      return { ok: false, output: "", error: (error as Error).message };
    }
  }
}

export class ReadTaskGraph implements Tool<Record<string, never>> {
  readonly name = "read_task_graph";
  readonly description =
    "Show the active plan: every node, its status, the current node and the next one. Use this after a compaction or a restart to find out where you are.";
  readonly readOnly = true;
  private readonly schemaObject = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaObject.parse(input);
  }

  async run(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const dag = ctx.dag;
    if (dag === undefined) {
      return { ok: true, output: "No task graph is active. Use plan_task to create one." };
    }
    const snapshot = dag.snapshot();
    if (snapshot.nodes.length === 0) {
      return { ok: true, output: "A task graph exists but is empty." };
    }
    return {
      ok: true,
      output: `${formatDag(dag)}\n${describeSnapshot(snapshot)}`,
      metadata: { done: snapshot.done, blocked: dag.blocked },
    };
  }
}

export class ResumeTask implements Tool<Record<string, never>> {
  readonly name = "resume_task";
  readonly description =
    "Load a plan left behind by an earlier session in this workspace and report where it stopped. Use it when the user says to continue previous work.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaObject = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaObject.parse(input);
  }

  async run(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const dag = ctx.dag;
    if (dag === undefined) {
      return { ok: false, output: "", error: "No task graph is active for this session." };
    }
    if (dag.all().length === 0) {
      return { ok: true, output: "There is no plan to resume in this workspace." };
    }
    const next = dag.next();
    const snapshot = dag.snapshot();
    return {
      ok: true,
      output: [
        formatDag(dag),
        describeSnapshot(snapshot),
        next !== undefined ? `Resume with node ${next.id}: ${next.title}` : snapshot.done ? "The plan is complete." : "The plan is blocked: a failed node needs a decision.",
      ].join("\n"),
      metadata: { nextNode: next?.id ?? null },
    };
  }
}

function formatDag(dag: PersistentTaskDAG): string {
  const lines = [`objective: ${dag.snapshot().objective}`];
  for (const node of dag.all()) {
    const marker = node.status === "completed" ? "[x]" : node.status === "running" ? "[>]" : node.status === "verifying" ? "[~]" : node.status === "failed" ? "[!]" : "[ ]";
    const dependencies = node.dependencies.length > 0 ? ` (after ${node.dependencies.join(", ")})` : "";
    const criteria = node.acceptanceCriteria.length > 0 ? ` — done when: ${node.acceptanceCriteria}` : "";
    lines.push(`${marker} ${node.id} ${node.title}${dependencies}${criteria}`);
  }
  return lines.join("\n");
}
