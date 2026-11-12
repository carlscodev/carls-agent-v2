import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";

const inputSchema = z.object({
  path: z.string().describe("File to create or overwrite, absolute or workspace-relative."),
  content: z.string().describe("Full file content to write."),
});

type Input = z.infer<typeof inputSchema>;

export class FileWrite implements Tool<Input> {
  readonly name = "write_file";
  readonly description =
    "Write a complete file, creating any missing parent directories. Overwrites existing content atomically.";
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

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    try {
      const target = guardPath(ctx, input.path);
      const display = toDisplayPath(ctx.cwd, target);
      ctx.backups?.save(target);
      await mkdir(dirname(target), { recursive: true });
      // Write to a sibling temp file then rename, so a crash mid-write cannot
      // leave a truncated file behind.
      const tmp = join(dirname(target), `.${Date.now()}.${process.pid}.carls.tmp`);
      await writeFile(tmp, input.content, "utf8");
      await rename(tmp, target);

      const lineCount = input.content.length === 0 ? 0 : input.content.split("\n").length;
      ctx.logger.debug(`wrote ${display} (${input.content.length} bytes)`);
      return {
        ok: true,
        output: `Wrote ${display} (${lineCount} lines, ${input.content.length} bytes).`,
        metadata: { path: target, bytes: input.content.length },
      };
    } catch (error) {
      const message = (error as Error).message;
      return { ok: false, output: "", error: message.includes("outside the workspace") ? message : `Cannot write ${input.path}: ${message}` };
    }
  }
}
