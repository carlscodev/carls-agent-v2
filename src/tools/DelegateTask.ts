import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";

const inputSchema = z.object({
  goal: z
    .string()
    .describe(
      "Self-contained investigation goal. The sub-agent cannot see this conversation, so include every detail it needs.",
    ),
});

type Input = z.infer<typeof inputSchema>;

export class DelegateTask implements Tool<Input> {
  readonly name = "delegate_task";
  readonly description =
    "Spawn an isolated read-only sub-agent to explore the codebase and return a structured conclusion. Use it to keep this context window lean.";
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
    return inputSchema.parse(input);
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.spawnSubAgent) {
      return { ok: false, output: "", error: "Sub-agents are not available in this session." };
    }
    try {
      const report = await ctx.spawnSubAgent(input.goal);
      return { ok: true, output: report, metadata: { subAgent: true } };
    } catch (error) {
      return { ok: false, output: "", error: `Sub-agent failed: ${(error as Error).message}` };
    }
  }
}
