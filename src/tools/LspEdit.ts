import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";
import { LspClient } from "../lsp/Client.js";
import { planWorkspaceEdit, type WorkspaceEdit } from "../lsp/Edits.js";
import { specForPath } from "./Lsp.js";

/**
 * `lsp_edit` — the applying half of `lsp`.
 *
 * Rename and quick fixes arrive as a `WorkspaceEdit`. Recomputing that across
 * files by hand is exactly what a language server exists to prevent, so this
 * tool plans the edits, shows what it would touch on a dry run, and writes them
 * through the same workspace guard as every other file tool.
 */

const INIT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

interface LspEditInput {
  path: string;
  line: number;
  character: number;
  action: "codeAction" | "rename";
  index?: number | undefined;
  newName?: string | undefined;
  dryRun?: boolean | undefined;
}

export class LspEdit implements Tool<LspEditInput> {
  readonly name = "lsp_edit";
  readonly description =
    "Apply a language-server edit at a position: rename a symbol everywhere (action \"rename\" with newName), or apply one of the quick fixes listed by lsp (action \"codeAction\" with its 1-based index). Pass dryRun to see the files it would change without writing. Needs lspServers in the config.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File the position belongs to, absolute or workspace-relative."),
    line: z.number().int().positive().describe("1-based line."),
    character: z.number().int().positive().describe("1-based column."),
    action: z.enum(["codeAction", "rename"]).describe("Which edit to ask the language server for."),
    index: z.number().int().positive().optional().describe("1-based code action index, for action \"codeAction\"."),
    newName: z.string().min(1).optional().describe("New symbol name, for action \"rename\"."),
    dryRun: z.boolean().optional().describe("Only report the files and edit counts; write nothing."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): LspEditInput {
    return this.schemaDef.parse(input);
  }

  async run(input: LspEditInput, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === "rename" && input.newName === undefined) {
      return { ok: false, output: "", error: "rename needs newName." };
    }
    if (input.action === "codeAction" && input.index === undefined) {
      return { ok: false, output: "", error: "codeAction needs index (1-based, as listed by lsp)." };
    }

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

    const client = new LspClient(found.spec, ctx.cwd);
    try {
      await client.initialize(found.spec, ctx.cwd, INIT_TIMEOUT_MS);
      const languageId = found.spec.languageId ?? found.key.replace(/^\./, "");
      client.openDocument(target, text, languageId);

      let edit: WorkspaceEdit | undefined;
      let label: string;
      if (input.action === "rename") {
        label = `rename to "${input.newName ?? ""}"`;
        edit = await client.rename(target, input.line, input.character, input.newName ?? "", REQUEST_TIMEOUT_MS);
        if (edit === undefined) {
          return { ok: false, output: "", error: `the language server cannot rename the symbol at ${display}:${input.line}:${input.character}` };
        }
      } else {
        const diagnostics = await client.diagnosticsFor(target, text, languageId, REQUEST_TIMEOUT_MS);
        const actions = await client.codeActions(target, input.line, input.character, diagnostics, REQUEST_TIMEOUT_MS);
        const chosen = actions[(input.index ?? 1) - 1];
        if (chosen === undefined) {
          return {
            ok: false,
            output: "",
            error: `no code action #${input.index ?? 1} at ${display}:${input.line}:${input.character} (the server offered ${actions.length}).`,
          };
        }
        label = `"${chosen.title}"`;
        // A command-only action is a server-side request we cannot run safely.
        edit = chosen.edit;
        if (edit === undefined) {
          return {
            ok: false,
            output: "",
            error: `code action "${chosen.title}" carries no edit (it asks the client to run a command), so it cannot be applied here.`,
          };
        }
      }

      const planned = await planWorkspaceEdit(edit, (path) => guardPath(ctx, path));
      if (planned.length === 0) {
        return { ok: false, output: "", error: `the ${label} edit is empty; nothing to write.` };
      }
      const rows = planned.map((item) => `${toDisplayPath(ctx.cwd, item.path)}: ${item.edits} edit${item.edits === 1 ? "" : "s"}`);
      if (input.dryRun === true) {
        return {
          ok: true,
          output: `${label} would change ${planned.length} file${planned.length === 1 ? "" : "s"}\n${rows.join("\n")}`,
          metadata: { paths: planned.map((item) => item.path), dryRun: true },
        };
      }
      for (const item of planned) {
        await writeFile(item.path, item.text, "utf8");
      }
      // The file moved under the server's feet; keeping it open would serve
      // stale content on the next request.
      return {
        ok: true,
        output: `${label} applied to ${planned.length} file${planned.length === 1 ? "" : "s"}\n${rows.join("\n")}`,
        metadata: { paths: planned.map((item) => item.path) },
      };
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
