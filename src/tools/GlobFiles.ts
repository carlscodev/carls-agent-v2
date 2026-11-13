import { globby } from "globby";
import { homedir } from "node:os";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { IGNORED_GLOB_PATTERNS } from "../utils/ignoredDirs.js";
import { samePath } from "../utils/platform.js";

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts' or '**/*.json'."),
  limit: z.number().int().positive().optional().describe("Max paths to return (default 200)."),
});

type Input = z.infer<typeof inputSchema>;

export class GlobFiles implements Tool<Input> {
  readonly name = "glob_files";
  readonly description =
    "Find files by glob pattern. Ignores node_modules, .git, dist, build, coverage and Windows/macOS home and system directories; a home-directory cwd is walked at most two levels deep.";
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
    const atHome = samePath(ctx.cwd, homedir());
    const limit = atHome ? Math.min(input.limit ?? 200, 200) : (input.limit ?? 200);
    try {
      const matches = await globby(input.pattern, {
        cwd: ctx.cwd,
        ignore: [...IGNORED_GLOB_PATTERNS],
        dot: false,
        onlyFiles: true,
        gitignore: true,
        absolute: false,
        // The home profile is not a project. Keep an explicit glob from
        // enumerating AppData, Windows or Program Files recursively.
        ...(atHome ? { deep: 2 } : {}),
      });
      matches.sort();
      const shown = matches.slice(0, limit);
      if (shown.length === 0) {
        return { ok: true, output: `No files match "${input.pattern}".` };
      }
      const suffix =
        matches.length > shown.length
          ? `\n... (${matches.length - shown.length} more not shown)`
          : "";
      return {
        ok: true,
        output: shown.join("\n") + suffix,
        metadata: { total: matches.length, shown: shown.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `glob failed: ${(error as Error).message}` };
    }
  }
}
