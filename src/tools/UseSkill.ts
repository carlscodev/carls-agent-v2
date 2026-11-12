import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";

const inputSchema = z.object({
  name: z.string().describe("Exact skill name, as listed in the available skills."),
  issue: z
    .string()
    .optional()
    .describe("Set this when the skill was wrong, stale or incomplete. The note feeds the review queue."),
});

type Input = z.infer<typeof inputSchema>;

/**
 * Reads a skill's full instructions into the conversation. The model sees only
 * names and descriptions up front, so loading a body is an explicit decision
 * that keeps the context window small.
 */
export class UseSkill implements Tool<Input> {
  readonly name = "use_skill";
  readonly description =
    "Load the full instructions of a skill by name. Skills hold reusable procedures (design rules, provider setup, release steps). Read the one that matches the task before acting.";
  readonly readOnly = true;
  readonly category = "read" as const;

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(inputSchema) };
  }

  parse(input: unknown): Input {
    return inputSchema.parse(input);
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    const skill = ctx.skills?.get(input.name);
    if (skill === undefined) {
      // A wrong name is the common failure, and dumping 40 names does not fix
      // it. Rank the catalog against what was asked for and suggest the closest.
      const suggestions = (ctx.skills?.search(input.name, 3) ?? []).map((hit) => hit.skill.name);
      const hint =
        suggestions.length > 0
          ? `Did you mean: ${suggestions.join(", ")}?`
          : `Search with /skills search <query> to find the right name.`;
      const available = ctx.skills?.skills.map((entry) => entry.name).slice(0, 40) ?? [];
      return {
        ok: false,
        output: "",
        error: `Unknown skill "${input.name}". ${hint}\nAvailable: ${available.join(", ")}`,
      };
    }
    ctx.skills?.recordUse(skill.name);
    if (input.issue !== undefined && input.issue.trim().length > 0) {
      ctx.skills?.flag(skill.name, input.issue.trim());
    }
    const header = [
      `# Skill: ${skill.name}`,
      `source: ${skill.source} · path: ${skill.path}`,
      "",
    ].join("\n");
    return { ok: true, output: `${header}${skill.body}`, metadata: { skill: skill.name } };
  }
}
