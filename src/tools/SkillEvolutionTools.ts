import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { SkillEvolutionEngine } from "../skills/SkillEvolutionEngine.js";

/**
 * Tools for evolving skills.
 *
 * `save_skill` writes a skill. These tools do the harder, riskier thing: change
 * one that already works. That is why every path here validates first, records a
 * revision, and keeps a way back.
 */

function engine(ctx: ToolContext): SkillEvolutionEngine {
  return new SkillEvolutionEngine(ctx.cwd);
}

const proposalSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Skill name, lowercase with dashes."),
  description: z.string().describe("One line describing when the skill applies."),
  body: z.string().describe("Full markdown instructions."),
  when_to_use: z.string().optional().describe("A hint the model reads to decide whether to load it."),
  tags: z.array(z.string()).optional(),
  requires: z.array(z.string()).optional().describe("Skills that must be read before this one."),
  note: z.string().describe("Why this version is an improvement. Recorded in the skill's history."),
});

type Proposal = {
  name: string;
  description: string;
  body: string;
  when_to_use?: string | undefined;
  tags?: string[] | undefined;
  requires?: string[] | undefined;
  note: string;
};

export class EvolveSkill implements Tool<Proposal & { replace?: boolean | undefined }> {
  readonly name = "evolve_skill";
  readonly description =
    "Create or revise a skill through the curation gate: the proposal is validated, a rewrite that only grows longer without adding steps is refused, and every accepted version is recorded so it can be reverted with revert_skill.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaObject = proposalSchema.extend({
    replace: z.boolean().optional().describe("Revise an existing skill of the same name."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): Proposal & { replace?: boolean | undefined } {
    return this.schemaObject.parse(input);
  }

  async run(input: Proposal & { replace?: boolean | undefined }, ctx: ToolContext): Promise<ToolResult> {
    const outcome = engine(ctx).evolve(
      {
        name: input.name,
        description: input.description,
        body: input.body,
        ...(input.when_to_use !== undefined ? { whenToUse: input.when_to_use } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.requires !== undefined ? { requires: input.requires } : {}),
        note: input.note,
      },
      ctx.skills,
      input.replace === true,
    );

    if (!outcome.ok) {
      const problems = outcome.validation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.field}: ${issue.message}`);
      const warnings = outcome.validation.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => `${issue.field}: ${issue.message}`);
      const detail = [outcome.rejected, ...problems, ...warnings.map((warning) => `[warning] ${warning}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
      return { ok: false, output: "", error: detail.length > 0 ? detail : "the proposal was rejected" };
    }

    const warnings = outcome.validation.issues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => `[warning] ${issue.field}: ${issue.message}`);
    return {
      ok: true,
      output: [`Saved "${input.name}" v${outcome.version} to ${outcome.path}.`, ...warnings].join("\n"),
      metadata: { skill: input.name, version: outcome.version, path: outcome.path },
    };
  }
}

export class ReviewSkills implements Tool<Record<string, never>> {
  readonly name = "review_skills";
  readonly description =
    "List the skills that need attention and why: flagged as wrong, depending on a skill revised more recently, or never used. Use it before deciding what to improve.";
  readonly readOnly = true;
  private readonly schemaObject = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaObject.parse(input);
  }

  async run(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const queue = engine(ctx).reviewQueue(ctx.skills);
    if (queue.length === 0) {
      return { ok: true, output: "No skill needs attention." };
    }
    return {
      ok: true,
      output: queue.map((candidate) => `${candidate.name} (priority ${candidate.priority}): ${candidate.reason}`).join("\n"),
      metadata: { count: queue.length },
    };
  }
}

export class SkillHistoryTool implements Tool<{ name: string }> {
  readonly name = "skill_history";
  readonly description = "Show every recorded revision of a skill, with the note that explains each change.";
  readonly readOnly = true;
  private readonly schemaObject = z.object({ name: z.string().describe("Skill name.") });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): { name: string } {
    return this.schemaObject.parse(input);
  }

  async run(input: { name: string }, ctx: ToolContext): Promise<ToolResult> {
    const revisions = engine(ctx).historyFor(input.name);
    if (revisions.length === 0) {
      return { ok: true, output: `No recorded revisions for "${input.name}".` };
    }
    return {
      ok: true,
      output: revisions
        .map((revision) => `v${revision.version} (${revision.at}, ${revision.author}, ${revision.chars} chars): ${revision.note}`)
        .join("\n"),
      metadata: { versions: revisions.length },
    };
  }
}

export class RevertSkill implements Tool<{ name: string }> {
  readonly name = "revert_skill";
  readonly description =
    "Restore the previous revision of a skill. Use it when a rewrite turned out to be worse than what it replaced.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaObject = z.object({ name: z.string().describe("Skill name.") });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): { name: string } {
    return this.schemaObject.parse(input);
  }

  async run(input: { name: string }, ctx: ToolContext): Promise<ToolResult> {
    const result = engine(ctx).revert(input.name, ctx.skills);
    if (!result.ok) return { ok: false, output: "", error: result.detail };
    return { ok: true, output: `${result.detail} (now v${result.version}).`, metadata: { version: result.version } };
  }
}

export class SkillGraphTool implements Tool<Record<string, never>> {
  readonly name = "skill_graph";
  readonly description =
    "Show how skills depend on each other, declared through `requires` and `extends` in their frontmatter. Use it before deleting or heavily rewriting a skill that others build on.";
  readonly readOnly = true;
  private readonly schemaObject = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaObject.parse(input);
  }

  async run(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const graph = engine(ctx).graph();
    const cycles = graph.cycles();
    const lines = [graph.format()];
    if (cycles.length > 0) {
      lines.push(`[warning] dependency cycle(s): ${cycles.map((cycle) => cycle.join(" -> ")).join("; ")}`);
    }
    return { ok: true, output: lines.join("\n"), metadata: { edges: graph.all().length, cycles: cycles.length } };
  }
}
