import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import type { RepoMap } from "../core/RepoMap.js";

const inputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Symbol name or fragment to look up, e.g. 'guardPath' or 'Provider'. Case-insensitive."),
  file: z
    .string()
    .optional()
    .describe("Workspace-relative file to outline, e.g. 'src/core/Runtime.ts'."),
  dependents: z
    .boolean()
    .optional()
    .describe("With `file`, list the files that import it."),
  budget_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Token budget for the whole map when no query is given (default 2000)."),
});

type Input = z.infer<typeof inputSchema>;

/**
 * The signature index as a tool. Cheap enough to call freely: it answers
 * "where is X defined" and "what does this module export" without the agent
 * reading whole files into its context.
 */
export class RepoMapTool implements Tool<Input> {
  readonly name = "repo_map";
  readonly description =
    "Query a symbol index of the whole workspace. Answers where a symbol is defined, what a file exports, and who imports it, using only signatures instead of file bodies. Prefer this before reading files.";
  readonly readOnly = true;
  readonly category = "read" as const;

  private readonly map: RepoMap;

  constructor(map: RepoMap) {
    this.map = map;
  }

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

  async run(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    try {
      if (this.map.size === 0 || this.map.isStale()) this.map.build();

      if (input.file !== undefined && input.dependents === true) {
        const dependents = this.map.dependents(input.file);
        const output =
          dependents.length === 0
            ? `No indexed file imports "${input.file}".`
            : `Imported by ${dependents.length} file${dependents.length === 1 ? "" : "s"}:\n${dependents.join("\n")}`;
        return { ok: true, output, metadata: { dependents: dependents.length } };
      }

      if (input.file !== undefined) {
        return { ok: true, output: this.map.renderFile(input.file) };
      }

      if (input.query !== undefined && input.query.trim().length > 0) {
        const found = this.map.find(input.query);
        if (found.length === 0) {
          return {
            ok: true,
            output: `No symbol matches "${input.query}". The map indexes ${this.map.size} files; try grep_search for a text match.`,
          };
        }
        const lines = found.map((symbol) => {
          const members = symbol.members?.map((member) => `      ${member}`) ?? [];
          return [`${symbol.file}:${symbol.line}  ${symbol.kind} ${symbol.name}`, ...members].join("\n");
        });
        return { ok: true, output: lines.join("\n"), metadata: { matches: found.length } };
      }

      const budget = input.budget_tokens ?? 2000;
      const stats = this.map.stats();
      return {
        ok: true,
        output: this.map.render(budget),
        metadata: { files: stats.files, symbols: stats.symbols, fullTokens: stats.fullTokens },
      };
    } catch (error) {
      return { ok: false, output: "", error: `repo_map failed: ${(error as Error).message}` };
    }
  }
}
