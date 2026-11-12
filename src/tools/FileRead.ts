import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath } from "../utils/paths.js";
import { splitLines } from "../utils/eol.js";

const inputSchema = z.object({
  path: z.string().describe("Path to the file, absolute or relative to the workspace root."),
  start_line: z.number().int().positive().optional().describe("1-based first line to read."),
  end_line: z.number().int().positive().optional().describe("1-based last line to read (inclusive)."),
});

type Input = z.infer<typeof inputSchema>;

const MAX_BYTES = 2 * 1024 * 1024;

export class FileRead implements Tool<Input> {
  readonly name = "read_file";
  readonly description =
    "Read a text file with line numbers. Optionally bound the range with start_line/end_line for precise context.";
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
    try {
      const target = guardPath(ctx, input.path);
      const info = await stat(target);
      if (info.isDirectory()) {
        return { ok: false, output: "", error: `${input.path} is a directory, not a file.` };
      }
      if (info.size > MAX_BYTES) {
        return {
          ok: false,
          output: "",
          error: `File too large (${info.size} bytes); max ${MAX_BYTES}. Use grep_search or bash (head/tail) instead.`,
        };
      }

      const content = await readFile(target, "utf8");
      // Split on any ending so a CRLF file does not show a trailing `\r` on every
      // line, which the model would then echo back into its `old_string`.
      const lines = splitLines(content);
      const start = Math.max(1, input.start_line ?? 1);
      const end = Math.min(lines.length, input.end_line ?? lines.length);
      if (start > lines.length) {
        return {
          ok: true,
          output: `(file has ${lines.length} lines; requested start_line ${start} is past EOF)`,
        };
      }

      const slice = lines.slice(start - 1, end);
      const width = String(end).length;
      const numbered = slice
        .map((line, index) => {
          const lineNo = String(start + index).padStart(width, " ");
          return `${lineNo}→${line}`;
        })
        .join("\n");

      return {
        ok: true,
        output: numbered,
        metadata: { path: target, lines: lines.length, shown: slice.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot read ${input.path}: ${(error as Error).message}` };
    }
  }
}
