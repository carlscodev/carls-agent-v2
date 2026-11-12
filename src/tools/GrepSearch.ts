import { globby } from "globby";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { splitLines } from "../utils/eol.js";

const inputSchema = z.object({
  pattern: z.string().describe("JavaScript regular expression to search for."),
  glob: z.string().optional().describe("Optional file glob to restrict the search (default '**/*')."),
  max_results: z.number().int().positive().optional().describe("Max matching lines (default 100)."),
  case_sensitive: z
    .boolean()
    .optional()
    .describe("Set false to ignore case. Default is case-sensitive, as written."),
  context: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Lines of surrounding context per match (default 0). Context lines are marked with a trailing dash."),
});

type Input = z.infer<typeof inputSchema>;

const IGNORED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"];
const MAX_FILE_BYTES = 1 * 1024 * 1024;

export class GrepSearch implements Tool<Input> {
  readonly name = "grep_search";
  readonly description =
    "Search file contents with a regular expression. Returns matching lines with file:line:col previews.";
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
    const maxResults = input.max_results ?? 100;
    const context = input.context ?? 0;
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.case_sensitive === false ? "i" : "");
    } catch (error) {
      return { ok: false, output: "", error: `Invalid regex: ${(error as Error).message}` };
    }

    try {
      const files = await globby(input.glob ?? "**/*", {
        cwd: ctx.cwd,
        ignore: IGNORED,
        dot: false,
        onlyFiles: true,
        gitignore: true,
        absolute: false,
      });

      const results: string[] = [];
      let truncated = false;

      for (const file of files) {
        if (results.length >= maxResults) {
          truncated = true;
          break;
        }
        let content: string;
        try {
          content = await readFile(`${ctx.cwd}/${file}`, "utf8");
        } catch {
          continue;
        }
        if (content.length > MAX_FILE_BYTES || content.includes("\u0000")) continue;

        const lines = splitLines(content);
        // Context windows can overlap, so each line is emitted at most once per
        // file and a match always wins over being shown as context.
        const emitted = new Set<number>();
        for (let index = 0; index < lines.length; index++) {
          if (results.length >= maxResults) {
            truncated = true;
            break;
          }
          const line = lines[index] ?? "";
          const match = regex.exec(line);
          if (!match) continue;

          const from = Math.max(0, index - context);
          const to = Math.min(lines.length - 1, index + context);
          for (let cursor = from; cursor <= to; cursor++) {
            if (emitted.has(cursor)) continue;
            emitted.add(cursor);
            const text = (lines[cursor] ?? "").trim().slice(0, 300);
            if (cursor === index) {
              results.push(`${file}:${cursor + 1}:${match.index + 1}: ${text}`);
            } else {
              results.push(`${file}:${cursor + 1}- ${text}`);
            }
            if (results.length >= maxResults) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
      }

      if (results.length === 0) {
        return { ok: true, output: `No matches for /${input.pattern}/.` };
      }
      const suffix = truncated ? "\n... (results truncated; narrow the pattern or raise max_results)" : "";
      return {
        ok: true,
        output: results.join("\n") + suffix,
        metadata: { matches: results.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `grep failed: ${(error as Error).message}` };
    }
  }
}
