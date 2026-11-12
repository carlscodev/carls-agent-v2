import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";
import { renderDiff } from "../utils/DiffRenderer.js";
import { applyEol, detectEol, toLf } from "../utils/eol.js";

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class FileEdit implements Tool<Input> {
  readonly name = "edit_file";
  readonly description =
    "Replace an exact string in a file. Fails unless old_string matches exactly once (or replace_all is set). Returns a colored unified diff. Matching is line-ending agnostic: an LF old_string matches a CRLF file, and the file keeps its original line endings.";
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

  /**
   * Matches `old_string` against the file, accepting either line ending. The
   * pattern is built from the escaped lines so that a literal LF in the request
   * matches a `\r\n` in a Windows file. Matching this way, rather than
   * normalising the whole file first, leaves every untouched byte exactly as it
   * was, so an edit cannot rewrite a file's line endings behind the user's back.
   */
  private buildMatcher(needleLf: string, global: boolean): RegExp {
    const pattern = needleLf.split("\n").map(escapeRegExp).join("\\r?\\n");
    return new RegExp(pattern, global ? "g" : "");
  }

  /** Applies the edit, giving any new line the ending the surrounding text uses. */
  private apply(current: string, input: Input): string {
    const needle = toLf(input.old_string);
    if (needle.length === 0) return current;
    const fallback = detectEol(current).eol;
    const replacement = toLf(input.new_string);
    const matcher = this.buildMatcher(needle, input.replace_all === true);
    return current.replace(matcher, (matched: string, offset: number) =>
      applyEol(replacement, this.endingFor(current, matched, offset, fallback)),
    );
  }

  /**
   * Picks the line ending for the replacement from the region it replaces: the
   * match itself when it spans lines, otherwise the ending that follows it. This
   * keeps a mixed file mixed instead of imposing one ending on it.
   */
  private endingFor(current: string, matched: string, offset: number, fallback: "\n" | "\r\n"): "\n" | "\r\n" {
    if (matched.includes("\r\n")) return "\r\n";
    const after = current.slice(offset + matched.length, offset + matched.length + 2);
    if (after.startsWith("\r\n")) return "\r\n";
    if (after.startsWith("\n")) return "\n";
    return fallback;
  }

  /** Occurrences of `old_string` in `current`, ignoring line-ending differences. */
  private countMatches(current: string, input: Input): number {
    const needle = toLf(input.old_string);
    if (needle.length === 0) return 0;
    return [...current.matchAll(this.buildMatcher(needle, true))].length;
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      const current = await readFile(target, "utf8");
      const occurrences = this.countMatches(current, input);

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
      if (toLf(input.old_string) === toLf(input.new_string)) {
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
