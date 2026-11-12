import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { SkillLoader } from "../skills/SkillLoader.js";

const inputSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes")
    .describe("Skill name, lowercase with dashes, e.g. godot-scene-authoring."),
  description: z.string().describe("One line describing when this skill applies. Shown to the model."),
  body: z.string().describe("Full markdown instructions for the skill."),
  tags: z.array(z.string()).optional().describe("Optional keywords that improve matching."),
  overwrite: z.boolean().optional().describe("Replace an existing skill of the same name."),
});

type Input = z.infer<typeof inputSchema>;

/**
 * Writes a new skill into `.agents/skills/<name>/SKILL.md`, so the agent can
 * capture a working procedure and reuse it in later sessions. This is the write
 * half of the self-improving loop.
 */
export class SaveSkill implements Tool<Input> {
  readonly name = "save_skill";
  readonly description =
    "Save a reusable procedure as a project skill so future sessions can load it with use_skill. Use it after discovering a non-obvious workflow.";
  readonly readOnly = false;
  readonly category = "write" as const;

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(inputSchema) };
  }

  parse(input: unknown): Input {
    return inputSchema.parse(input);
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    ctx.skills?.refresh();
    const existing = ctx.skills?.get(input.name);
    if (existing !== undefined && existing.source !== "project" && input.overwrite !== true) {
      return {
        ok: false,
        output: "",
        error: `A ${existing.source} skill named "${input.name}" already exists. Pass overwrite:true to shadow it in this project.`,
      };
    }
    if (existing?.source === "project" && input.overwrite !== true) {
      return {
        ok: false,
        output: "",
        error: `Project skill "${input.name}" already exists. Pass overwrite:true to replace it.`,
      };
    }

    const tags = input.tags ?? [];
    const frontmatter = [
      "---",
      `name: ${input.name}`,
      `description: ${input.description}`,
      `version: ${(existing?.version ?? 0) + 1}`,
      `tags: [${tags.join(", ")}]`,
      "---",
      "",
    ].join("\n");
    const content = `${frontmatter}${input.body.trim()}\n`;

    try {
      const file = SkillLoader.write(ctx.cwd, input.name, content);
      ctx.backups?.save(file);
      ctx.skills?.refresh();
      return {
        ok: true,
        output: `Saved skill "${input.name}" to ${file}.`,
        metadata: { skill: input.name, path: file },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Could not write the skill: ${(error as Error).message}` };
    }
  }
}
