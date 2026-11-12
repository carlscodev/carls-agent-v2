import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import type { LspServerSpec } from "../config/Config.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";
import { LspClient, severityLabel } from "../lsp/Client.js";

/**
 * `lsp_diagnostics`.
 *
 * Runs the language server the project configured for an extension, opens the
 * file and reports the diagnostics it pushes back. No server is installed or
 * guessed: `lspServers` in the config names it, because spawning an unexpected
 * binary is exactly the kind of thing a coding agent should not do on its own.
 */

const INIT_TIMEOUT_MS = 15_000;
const DIAGNOSTICS_TIMEOUT_MS = 12_000;

/** Picks the server spec for a path, by extension, then by filename. */
export function specForPath(
  servers: Record<string, LspServerSpec> | undefined,
  path: string,
): { key: string; spec: LspServerSpec } | undefined {
  if (servers === undefined) return undefined;
  const extension = extname(path).toLowerCase();
  for (const [key, spec] of Object.entries(servers)) {
    if (key.toLowerCase() === extension) return { key, spec };
  }
  const base = path.split(/[\\/]/).pop() ?? "";
  for (const [key, spec] of Object.entries(servers)) {
    if (key.toLowerCase() === base.toLowerCase()) return { key, spec };
  }
  return undefined;
}

interface LspInput {
  path: string;
  action?: "diagnostics" | "hover" | "definition" | undefined;
  line?: number | undefined;
  character?: number | undefined;
}

export class LspTool implements Tool<LspInput> {
  readonly name = "lsp";
  readonly description =
    "Ask the project's language server about one file: errors and warnings (diagnostics), the type or docs at a position (hover), or where a symbol is defined (definition). Needs lspServers in the config, e.g. {\"lspServers\": {\".ts\": {\"command\": \"typescript-language-server\", \"args\": [\"--stdio\"]}}}.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to check, absolute or workspace-relative."),
    action: z
      .enum(["diagnostics", "hover", "definition"])
      .optional()
      .describe("What to ask for; defaults to diagnostics."),
    line: z.number().int().positive().optional().describe("1-based line, for hover and definition."),
    character: z.number().int().positive().optional().describe("1-based column, for hover and definition."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): LspInput {
    return this.schemaDef.parse(input);
  }

  async run(input: LspInput, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    const found = specForPath(ctx.config.lspServers, target);
    if (found === undefined) {
      return {
        ok: false,
        output: "",
        error:
          `no language server is configured for ${display}. Add "lspServers" to .carlsrc.json, ` +
          `for example {"lspServers": {".ts": {"command": "typescript-language-server", "args": ["--stdio"]}}}.`,
      };
    }

    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      return { ok: false, output: "", error: `could not read ${display}: ${(error as Error).message}` };
    }

    const action = input.action ?? "diagnostics";
    if (action !== "diagnostics" && (input.line === undefined || input.character === undefined)) {
      return {
        ok: false,
        output: "",
        error: `${action} needs a position: pass line and character (both 1-based).`,
      };
    }

    const client = new LspClient(found.spec, ctx.cwd);
    try {
      await client.initialize(found.spec, ctx.cwd, INIT_TIMEOUT_MS);
      const languageId = found.spec.languageId ?? found.key.replace(/^\./, "");

      if (action === "hover") {
        client.openDocument(target, text, languageId);
        const content = await client.hover(target, input.line ?? 1, input.character ?? 1, DIAGNOSTICS_TIMEOUT_MS);
        return content.length > 0
          ? { ok: true, output: `${display}:${input.line}:${input.character}\n${content}` }
          : { ok: false, output: "", error: `the language server returned no hover information at ${display}:${input.line}:${input.character}` };
      }

      if (action === "definition") {
        client.openDocument(target, text, languageId);
        const locations = await client.definition(target, input.line ?? 1, input.character ?? 1, DIAGNOSTICS_TIMEOUT_MS);
        if (locations.length === 0) {
          return { ok: false, output: "", error: `no definition found at ${display}:${input.line}:${input.character}` };
        }
        const lines = locations.map((location) => {
          const shown = toDisplayPath(ctx.cwd, location.path);
          return `${shown}:${location.line}:${location.character}`;
        });
        return { ok: true, output: `${locations.length} definition${locations.length === 1 ? "" : "s"}\n${lines.join("\n")}` };
      }

      const diagnostics = await client.diagnosticsFor(target, text, languageId, DIAGNOSTICS_TIMEOUT_MS);
      if (diagnostics.length === 0) return { ok: true, output: `${display}: no diagnostics.` };

      const lines = diagnostics.map((diagnostic) => {
        const line = diagnostic.range.start.line + 1;
        const column = diagnostic.range.start.character + 1;
        const source = diagnostic.source !== undefined ? ` (${diagnostic.source})` : "";
        const code = diagnostic.code !== undefined ? ` [${diagnostic.code}]` : "";
        return `${display}:${line}:${column} ${severityLabel(diagnostic.severity)}: ${diagnostic.message}${source}${code}`;
      });
      const errors = diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) === 1).length;
      const summary = `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})`;
      return { ok: errors === 0, output: `${summary}\n${lines.join("\n")}` };
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: `language server "${found.spec.command}" failed: ${(error as Error).message}`,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
