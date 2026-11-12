import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { formatOutcomes } from "../core/SubAgentPool.js";

const ROLES = ["explorer", "planner", "auditor", "tester"] as const;

const taskSchema = z.object({
  goal: z
    .string()
    .describe("Self-contained investigation goal. The sub-agent cannot see this conversation."),
  role: z
    .enum(ROLES)
    .describe(
      "explorer maps where code lives; planner orders the change; auditor hunts bugs; tester finds what is untested.",
    ),
});

const inputSchema = z.object({
  goal: z
    .string()
    .optional()
    .describe(
      "Single investigation goal. Use `tasks` instead when you have several independent questions to ask at once.",
    ),
  role: z.enum(ROLES).optional().describe("Role for the single-goal form. Defaults to explorer."),
  tasks: z
    .array(taskSchema)
    .optional()
    .describe(
      "Several independent investigations to run in parallel. Prefer this over repeated single calls: independent reading is free to overlap.",
    ),
});

type Input = z.infer<typeof inputSchema>;

/**
 * The parent's only door to a sub-agent. One goal runs a single child; several
 * goals run a pool, which is what turns a wide question ("where is this config
 * read?") into one turn instead of five.
 */
export class DelegateTask implements Tool<Input> {
  readonly name = "delegate_task";
  readonly description =
    "Spawn isolated read-only sub-agents and get structured reports back. Pass `goal` for one investigation, or `tasks` to run several in parallel. Use it to keep this context window lean.";
  readonly readOnly = true;
  readonly category = "read" as const;

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(inputSchema),
    };
  }

  parse(input: unknown): Input {
    const parsed = inputSchema.parse(input);
    if (parsed.goal === undefined && (parsed.tasks === undefined || parsed.tasks.length === 0)) {
      throw new Error("delegate_task needs either `goal` or a non-empty `tasks` array.");
    }
    return parsed;
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    if (input.tasks !== undefined && input.tasks.length > 0) {
      if (ctx.spawnSubAgentPool === undefined) {
        return { ok: false, output: "", error: "Sub-agents are not available in this session." };
      }
      const limit = ctx.subAgentPoolLimit ?? input.tasks.length;
      if (input.tasks.length > limit) {
        return {
          ok: false,
          output: "",
          error: `Too many tasks: ${input.tasks.length} requested, at most ${limit} per call. Split them across turns.`,
        };
      }
      try {
        const outcomes = await ctx.spawnSubAgentPool(input.tasks);
        const failed = outcomes.filter((outcome) => !outcome.ok).length;
        return {
          ok: true,
          output: formatOutcomes(outcomes),
          metadata: { subAgents: outcomes.length, failed },
        };
      } catch (error) {
        return { ok: false, output: "", error: `Sub-agent pool failed: ${(error as Error).message}` };
      }
    }

    if (ctx.spawnSubAgent === undefined) {
      return { ok: false, output: "", error: "Sub-agents are not available in this session." };
    }
    try {
      const report = await ctx.spawnSubAgent(input.goal ?? "", input.role ?? "explorer");
      return { ok: true, output: report, metadata: { subAgent: true } };
    } catch (error) {
      return { ok: false, output: "", error: `Sub-agent failed: ${(error as Error).message}` };
    }
  }
}
