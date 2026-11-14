import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";

/**
 * Background process tools.
 *
 * `bg_start` returns as soon as the port is detected (or the readiness window
 * closes), not when the server exits. The process stays under
 * `ProcessSentinel`, which owns its logs, crash counter and cleanup.
 */

const startSchema = z.object({
  command: z.string().min(1).describe("Command to start, e.g. `npm run dev` or `vite`."),
  name: z.string().optional().describe("Human name for logs and /ps."),
  waitForPortMs: z.number().int().positive().optional().describe("Readiness window in ms (default 3000)."),
});

const logsSchema = z.object({
  id: z.string().optional().describe("Process id from bg_start."),
  name: z.string().optional().describe("Process name, when id is unknown."),
  lines: z.number().int().positive().optional().describe("Number of recent lines (default 50)."),
});

const stopSchema = z.object({
  id: z.string().optional().describe("Process id from bg_start."),
  name: z.string().optional().describe("Process name, when id is unknown."),
});

function missing(ctx: ToolContext): ToolResult | undefined {
  return ctx.processes === undefined
    ? { ok: false, output: "", error: "Background processes are not available in this runtime." }
    : undefined;
}

function target(input: { id?: string | undefined; name?: string | undefined }, ctx: ToolContext): string | undefined {
  if (input.id !== undefined) return input.id;
  if (input.name !== undefined) return input.name;
  const all = ctx.processes?.list() ?? [];
  return all.length === 1 ? all[0]?.id : undefined;
}

export class BgStart implements Tool<z.infer<typeof startSchema>> {
  readonly name = "bg_start";
  readonly description =
    "Start a long-running dev server or watcher in the background. Returns as soon as a local port is detected or after a short readiness window, so `npm run dev` never blocks the turn. Use bg_logs to read it and bg_stop to kill it.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaObject = startSchema;

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): z.infer<typeof startSchema> {
    return this.schemaObject.parse(input);
  }

  async run(input: z.infer<typeof startSchema>, ctx: ToolContext): Promise<ToolResult> {
    const unavailable = missing(ctx);
    if (unavailable !== undefined) return unavailable;
    try {
      const process = await ctx.processes!.start(input.command, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.waitForPortMs !== undefined ? { waitForPortMs: input.waitForPortMs } : {}),
      });
      const recentOutput = process.output.slice(-10);
      const payload = {
        id: process.id,
        pid: process.pid,
        status: process.status,
        port: process.port ?? null,
        recentOutput,
      };
      const head = `Started ${process.id} (${process.name}) · ${process.status}${process.port !== undefined ? ` · port ${process.port}` : ""}`;
      return {
        ok: true,
        output: `${head}\n${JSON.stringify(payload)}`,
        metadata: {
          id: process.id,
          pid: process.pid,
          status: process.status,
          ...(process.port !== undefined ? { port: process.port } : {}),
          errorCount: process.errorCount,
        },
      };
    } catch (error) {
      return { ok: false, output: "", error: `bg_start failed: ${(error as Error).message}` };
    }
  }
}

export class BgLogs implements Tool<z.infer<typeof logsSchema>> {
  readonly name = "bg_logs";
  readonly description =
    "Read the last lines of a background process without blocking. The ring buffer keeps the last 200 lines and counts error-like stderr lines, so a dev server that crashed after an edit is visible immediately.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaObject = logsSchema;

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): z.infer<typeof logsSchema> {
    return this.schemaObject.parse(input);
  }

  async run(input: z.infer<typeof logsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const unavailable = missing(ctx);
    if (unavailable !== undefined) return unavailable;
    const idOrName = target(input, ctx);
    if (idOrName === undefined) {
      return { ok: false, output: "", error: "Pass an id or name (there are multiple background processes)." };
    }
    const process = ctx.processes!.find(idOrName);
    if (process === undefined) return { ok: false, output: "", error: `No background process "${idOrName}".` };
    const lines = ctx.processes!.logs(idOrName, input.lines ?? 50);
    return {
      ok: true,
      output: lines.length > 0 ? lines.join("\n") : "(no output yet)",
      metadata: {
        id: process.id,
        status: process.status,
        ...(process.port !== undefined ? { port: process.port } : {}),
        errorCount: process.errorCount,
        lines: lines.length,
      },
    };
  }
}

export class BgStop implements Tool<z.infer<typeof stopSchema>> {
  readonly name = "bg_stop";
  readonly description = "Stop a background process by id or name, killing its whole process tree and releasing the port.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaObject = stopSchema;

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaObject) };
  }

  parse(input: unknown): z.infer<typeof stopSchema> {
    return this.schemaObject.parse(input);
  }

  async run(input: z.infer<typeof stopSchema>, ctx: ToolContext): Promise<ToolResult> {
    const unavailable = missing(ctx);
    if (unavailable !== undefined) return unavailable;
    const idOrName = target(input, ctx);
    if (idOrName === undefined) {
      return { ok: false, output: "", error: "Pass an id or name (there are multiple background processes)." };
    }
    const result = await ctx.processes!.stop(idOrName);
    if (!result.ok) return { ok: false, output: "", error: result.detail };
    return {
      ok: true,
      output: `Stopped ${result.id ?? idOrName}${result.pid !== undefined ? ` (pid ${result.pid})` : ""}.`,
      metadata: { id: result.id, pid: result.pid },
    };
  }
}
