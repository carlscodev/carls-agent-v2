import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";
import { renderDiff } from "../utils/DiffRenderer.js";

const inputSchema = z.object({
  path: z.string().describe("File to edit."),
  old_string: z.string().describe("Exact text to replace. Must match exactly once."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
});

type Input = z.infer<typeof inputSchema>;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export class FileEdit implements Tool<Input> {
  readonly name = "edit_file";
  readonly description =
    "Replace an exact string in a file. Fails unless old_string matches exactly once (or replace_all is set). Returns a colored unified diff.";
  readonly readOnly = false;
  readonly category = "write" as const;

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

  /** Rendered before approval so the user sees exactly what will change. */
  async preview(input: Input, ctx: ToolContext): Promise<string> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      const current = await readFile(target, "utf8");
      const next = this.apply(current, input);
      const diff = renderDiff(current, next, { color: process.stderr.isTTY === true });
      return `${display}\n${diff}`;
    } catch (error) {
      return `${display}\n(cannot preview: ${(error as Error).message})`;
    }
  }

  private apply(current: string, input: Input): string {
    if (input.replace_all === true) {
      return current.split(input.old_string).join(input.new_string);
    }
    return current.replace(input.old_string, input.new_string);
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      const current = await readFile(target, "utf8");
      const occurrences = countOccurrences(current, input.old_string);

      if (occurrences === 0) {
        return {
          ok: false,
          output: "",
          error: `old_string not found in ${display}. Read the file and match the text exactly, including whitespace.`,
        };
      }
      if (occurrences > 1 && input.replace_all !== true) {
        return {
          ok: false,
          output: "",
          error: `old_string matches ${occurrences} times in ${display}. Add surrounding context to make it unique, or set replace_all=true.`,
        };
      }
      if (input.old_string === input.new_string) {
        return { ok: false, output: "", error: "old_string and new_string are identical." };
      }

      const next = this.apply(current, input);
      const diff = renderDiff(current, next, { color: process.stderr.isTTY === true });
      ctx.backups?.save(target);
      await writeFile(target, next, "utf8");

      return {
        ok: true,
        output: `Edited ${display} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).\n${diff}`,
        metadata: {
          path: target,
          replacements: occurrences,
          added: input.new_string.split("\n").length,
          removed: input.old_string.split("\n").length,
          // Uncoloured diff so the view layer owns presentation; the coloured
          // copy above stays for the model, which reads plain text either way.
          diff: renderDiff(current, next, { color: false }),
        },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot edit ${display}: ${(error as Error).message}` };
    }
  }
}
