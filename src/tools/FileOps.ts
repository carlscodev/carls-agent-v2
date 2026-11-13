import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";
import { renderDiff } from "../utils/DiffRenderer.js";
import { applyHunks, parsePatch, writeAtomic } from "./helpers.js";
import { applyEol, detectEol, normalizePatch, splitLines, toLf } from "../utils/eol.js";

const MAX_READ_BYTES = 400_000;

export class MultiRead implements Tool<{paths: string[]; max_lines?: number  | undefined}> {
  readonly name = "multi_read";
  readonly description =
    "Read several files in one call, each prefixed with its path. Use when you already know which files matter.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    paths: z.array(z.string()).min(1).max(20).describe("Files to read, absolute or workspace-relative."),
    max_lines: z.number().int().positive().max(2000).optional().describe("Lines to read per file."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { paths: string[]; max_lines?: number  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {paths: string[]; max_lines?: number | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const limit = input.max_lines ?? 400;
    const blocks: string[] = [];
    const missing: string[] = [];
    for (const path of input.paths) {
      const target = guardPath(ctx, path);
      const display = toDisplayPath(ctx.cwd, target);
      try {
        const info = await stat(target);
        if (info.size > MAX_READ_BYTES) {
          blocks.push(`=== ${display} ===\n(file too large: ${info.size} bytes)`);
          continue;
        }
        const text = await readFile(target, "utf8");
        const lines = splitLines(text);
        const shown = lines.slice(0, limit);
        const suffix = lines.length > limit ? `\n… ${lines.length - limit} more lines` : "";
        blocks.push(`=== ${display} (${lines.length} lines) ===\n${shown.join("\n")}${suffix}`);
      } catch (error) {
        missing.push(`${display}: ${(error as Error).message}`);
      }
    }
    const output = [...blocks, ...(missing.length > 0 ? [`[unreadable]\n${missing.join("\n")}`] : [])].join("\n\n");
    return { ok: blocks.length > 0, output, ...(blocks.length === 0 ? { error: "No file could be read." } : {}) };
  }
}

export class FileAppend implements Tool<{path: string; content: string}> {
  readonly name = "file_append";
  readonly description = "Append text to the end of a file, creating it if missing. Use for logs and growing lists.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to append to."),
    content: z.string().describe("Text to append."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; content: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string; content: string}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      let existing = "";
      try {
        existing = await readFile(target, "utf8");
      } catch {
        existing = "";
      }
      ctx.backups?.save(target);
      const next = existing + input.content;
      await writeAtomic(target, next);
      return {
        ok: true,
        output: `Appended ${input.content.length} bytes to ${display} (now ${next.length} bytes).`,
        metadata: { path: target, bytes: next.length, appended: input.content.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot append to ${display}: ${(error as Error).message}` };
    }
  }
}

export class FileDelete implements Tool<{path: string; recursive?: boolean  | undefined}> {
  readonly name = "file_delete";
  readonly description = "Delete a file or directory. Requires an explicit path; refuses to delete outside the workspace.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File or directory to delete."),
    recursive: z.boolean().optional().describe("Delete a directory and its contents."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; recursive?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async preview(input: {path: string}, ctx: ToolContext): Promise<string> {
    const target = guardPath(ctx, input.path);
    return `delete ${toDisplayPath(ctx.cwd, target)}`;
  }

  async run(input: {path: string; recursive?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    if (target === "/" || target === ctx.cwd) {
      return { ok: false, output: "", error: `Refusing to delete ${target}.` };
    }
    try {
      const info = await stat(target);
      if (info.isDirectory() && input.recursive !== true) {
        const entries = await readdir(target);
        if (entries.length > 0) {
          return {
            ok: false,
            output: "",
            error: `${display} is a non-empty directory. Pass recursive:true to delete it.`,
          };
        }
      }
      ctx.backups?.save(target);
      await rm(target, { recursive: input.recursive === true, force: false });
      return { ok: true, output: `Deleted ${display}.`, metadata: { path: target } };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot delete ${display}: ${(error as Error).message}` };
    }
  }
}

export class FileMove implements Tool<{from: string; to: string}> {
  readonly name = "file_move";
  readonly description = "Move or rename a file or directory, creating the destination's parent directories.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    from: z.string().describe("Current path."),
    to: z.string().describe("New path."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { from: string; to: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {from: string; to: string}, ctx: ToolContext): Promise<ToolResult> {
    const source = guardPath(ctx, input.from);
    const destination = guardPath(ctx, input.to);
    try {
      await mkdir(dirname(destination), { recursive: true });
      ctx.backups?.save(source);
      await rename(source, destination);
      return {
        ok: true,
        output: `Moved ${toDisplayPath(ctx.cwd, source)} → ${toDisplayPath(ctx.cwd, destination)}.`,
        metadata: { path: destination },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot move: ${(error as Error).message}` };
    }
  }
}

export class FileCopy implements Tool<{from: string; to: string}> {
  readonly name = "file_copy";
  readonly description = "Copy a file, creating the destination's parent directories.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    from: z.string().describe("Source path."),
    to: z.string().describe("Destination path."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { from: string; to: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {from: string; to: string}, ctx: ToolContext): Promise<ToolResult> {
    const source = guardPath(ctx, input.from);
    const destination = guardPath(ctx, input.to);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      return { ok: true, output: `Copied to ${toDisplayPath(ctx.cwd, destination)}.`, metadata: { path: destination } };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot copy: ${(error as Error).message}` };
    }
  }
}

export class MakeDir implements Tool<{path: string}> {
  readonly name = "make_dir";
  readonly description = "Create a directory and any missing parents. Succeeds when it already exists.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({ path: z.string().describe("Directory to create.") });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    try {
      await mkdir(target, { recursive: true });
      return { ok: true, output: `Created ${toDisplayPath(ctx.cwd, target)}.`, metadata: { path: target } };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot create directory: ${(error as Error).message}` };
    }
  }
}

export class TreeView implements Tool<{path?: string | undefined; depth?: number  | undefined}> {
  readonly name = "tree_view";
  readonly description =
    "Print a directory tree, ignoring .git, node_modules and build output. Faster than globbing when you need the shape of a project.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().optional().describe("Root directory, defaults to the workspace root."),
    depth: z.number().int().min(1).max(6).optional().describe("Maximum depth, default 3."),
  });
  private static readonly IGNORE = new Set([
    ".git", "node_modules", "dist", "build", ".next", "target", "vendor", "__pycache__", ".venv", ".cache",
  ]);

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path?: string | undefined ; depth?: number  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path?: string | undefined; depth?: number | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const root = guardPath(ctx, input.path ?? ".");
    const maxDepth = input.depth ?? 3;
    const lines: string[] = [toDisplayPath(ctx.cwd, root) || "."];
    let files = 0;
    let dirs = 0;

    const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
      if (depth > maxDepth) return;
      let entries: string[];
      try {
        entries = (await readdir(dir)).filter((entry) => !TreeView.IGNORE.has(entry)).sort();
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        let isDir = false;
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          dirs += 1;
          lines.push(`${prefix}${entry}/`);
          await walk(full, depth + 1, `${prefix}  `);
        } else {
          files += 1;
          lines.push(`${prefix}${entry}`);
        }
      }
    };
    await walk(root, 1, "  ");
    return {
      ok: true,
      output: `${lines.join("\n")}\n\n${dirs} directories, ${files} files`,
      metadata: { path: root, files, dirs },
    };
  }
}

export class FileDiff implements Tool<{path: string; against?: string  | undefined}> {
  readonly name = "file_diff";
  readonly description =
    "Show a unified diff between a file and another file, or between a file and its content on another git revision.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to diff."),
    against: z.string().optional().describe("Path of the other file. Omit to compare against git HEAD."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; against?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string; against?: string | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    try {
      const current = await readFile(target, "utf8");
      if (input.against !== undefined) {
        const other = await readFile(guardPath(ctx, input.against), "utf8");
        const diff = renderDiff(other, current, { color: false });
        return { ok: true, output: diff.length === 0 ? "No differences." : diff, metadata: { path: target } };
      }
      const { run } = await import("./helpers.js");
      const outcome = await run("git", ["show", `HEAD:${toDisplayPath(ctx.cwd, target)}`], {
        cwd: ctx.cwd,
        timeoutMs: 15_000,
      });
      if (outcome.exitCode !== 0) {
        return { ok: false, output: "", error: `git show failed: ${outcome.stderr.trim() || "not a git repository"}` };
      }
      const diff = renderDiff(outcome.stdout, current, { color: false });
      return { ok: true, output: diff.length === 0 ? "No differences against HEAD." : diff, metadata: { path: target } };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot diff: ${(error as Error).message}` };
    }
  }
}

export class ApplyPatch implements Tool<{path: string; patch: string; fuzz?: number  | undefined}> {
  readonly name = "apply_patch";
  readonly description =
    "Apply a unified diff to a file. Use for multi-hunk edits instead of many edit_file calls. Fails without writing when a hunk does not match.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to patch."),
    patch: z.string().describe("Unified diff, including @@ hunk headers."),
    fuzz: z.number().int().min(0).max(10).optional().describe("Lines of slack when locating a hunk."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; patch: string; fuzz?: number  | undefined } {
    return this.schemaDef.parse(input);
  }

  async preview(input: {path: string; patch: string; fuzz?: number | undefined}, ctx: ToolContext): Promise<string> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      const current = await readFile(target, "utf8");
      const next = this.applyText(current, input.patch, input.fuzz ?? 3);
      return `${display}\n${renderDiff(current, next, { color: process.stderr.isTTY === true })}`;
    } catch (error) {
      return `${display}\n(cannot preview: ${(error as Error).message})`;
    }
  }

  private applyText(current: string, patch: string, fuzz: number): string {
    // A diff produced on Windows carries `\r\n`; parsing it as-is leaves a stray
    // `\r` on every context line, so the hunk never matches.
    const hunks = parsePatch(normalizePatch(patch));
    if (hunks.length === 0) throw new Error("no @@ hunks found in the patch");
    // Match and apply in LF, then write the file back with its own line ending, so
    // patching a CRLF file does not rewrite every line.
    const { eol } = detectEol(current);
    const normalized = toLf(current);
    const hadTrailingNewline = normalized.endsWith("\n");
    const lines = normalized.split("\n");
    if (hadTrailingNewline) lines.pop();
    const patched = applyHunks(lines, hunks, fuzz).join("\n") + (hadTrailingNewline ? "\n" : "");
    return applyEol(patched, eol);
  }

  async run(input: {path: string; patch: string; fuzz?: number | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      const current = await readFile(target, "utf8");
      const next = this.applyText(current, input.patch, input.fuzz ?? 3);
      ctx.backups?.save(target);
      await writeAtomic(target, next);
      const hunks = parsePatch(input.patch);
      return {
        ok: true,
        output: `Patched ${display} (${hunks.length} hunk${hunks.length === 1 ? "" : "s"}).\n${renderDiff(current, next, { color: process.stderr.isTTY === true })}`,
        metadata: { path: target, hunks: hunks.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot patch ${display}: ${(error as Error).message}` };
    }
  }
}

export class HashFile implements Tool<{path: string; algorithm?: "sha256" | "md5" | "sha1"  | undefined}> {
  readonly name = "hash_file";
  readonly description = "Compute a file digest. Use to verify a download or detect whether a file changed.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to hash."),
    algorithm: z.enum(["sha256", "md5", "sha1"]).optional().describe("Defaults to sha256."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; algorithm?: "sha256" | "md5" | "sha1"  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string; algorithm?: "sha256" | "md5" | "sha1" | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const algorithm = input.algorithm ?? "sha256";
    try {
      const buffer = await readFile(target);
      const digest = createHash(algorithm).update(buffer).digest("hex");
      return {
        ok: true,
        output: `${algorithm} ${digest}  ${toDisplayPath(ctx.cwd, target)}`,
        metadata: { path: target, algorithm, digest },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot hash: ${(error as Error).message}` };
    }
  }
}

export class ListDir implements Tool<{path?: string | undefined; all?: boolean  | undefined}> {
  readonly name = "list_dir";
  readonly description =
    "List one directory level with sizes and modification times. Use it to answer 'what is in here' precisely.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().optional().describe("Directory to list, defaults to the workspace root."),
    all: z.boolean().optional().describe("Include dotfiles."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path?: string | undefined ; all?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path?: string | undefined; all?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path ?? ".");
    try {
      const entries = await readdir(target);
      const rows: string[] = [];
      for (const entry of entries.sort()) {
        if (input.all !== true && entry.startsWith(".")) continue;
        const full = join(target, entry);
        try {
          const info = await stat(full);
          const kind = info.isDirectory() ? "dir " : "file";
          const size = info.isDirectory() ? "-" : `${info.size}`;
          const when = info.mtime.toISOString().slice(0, 16).replace("T", " ");
          rows.push(`${kind} ${size.padStart(10)} ${when}  ${entry}`);
        } catch {
          rows.push(`?    ${entry}`);
        }
      }
      return {
        ok: true,
        output: `${toDisplayPath(ctx.cwd, target) || "."}:\n${rows.join("\n") || "(empty)"}`,
        metadata: { path: target, count: rows.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot list: ${(error as Error).message}` };
    }
  }
}

export class WriteMany implements Tool<{ files: { path: string; content: string }[] }> {
  readonly name = "write_many";
  readonly description =
    "Write several files in one call, atomically per file. Use when scaffolding a set of files that belong together.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    files: z
      .array(z.object({ path: z.string(), content: z.string() }))
      .min(1)
      .max(20)
      .describe("Files to write, in order."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { files: { path: string; content: string }[] } {
    return this.schemaDef.parse(input);
  }

  async run(input: {files: { path: string; content: string}[] }, ctx: ToolContext): Promise<ToolResult> {
    const written: string[] = [];
    const writtenPaths: string[] = [];
    for (const file of input.files) {
      const target = guardPath(ctx, file.path);
      ctx.backups?.save(target);
      await writeAtomic(target, file.content);
      written.push(`${toDisplayPath(ctx.cwd, target)} (${file.content.length} B)`);
      writtenPaths.push(target);
    }
    return { ok: true, output: `Wrote ${written.length} files:\n${written.join("\n")}`, metadata: { count: written.length, paths: writtenPaths } };
  }
}

export class PathInfo implements Tool<{path: string}> {
  readonly name = "path_info";
  readonly description = "Report whether a path exists, its type, size and modification time.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({ path: z.string().describe("Path to inspect.") });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    const display = toDisplayPath(ctx.cwd, target);
    try {
      const info = await stat(target);
      const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "special";
      return {
        ok: true,
        output: [
          `path     ${display}`,
          `absolute ${target}`,
          `kind     ${kind}`,
          `size     ${info.size} bytes`,
          `mode     ${(info.mode & 0o777).toString(8)}`,
          `modified ${info.mtime.toISOString()}`,
          `name     ${basename(target)}`,
        ].join("\n"),
        metadata: { path: target, exists: true, kind },
      };
    } catch {
      return { ok: true, output: `path ${display}\nexists false`, metadata: { path: target, exists: false } };
    }
  }
}

export class Base64File implements Tool<{path: string; decode?: string  | undefined}> {
  readonly name = "base64_file";
  readonly description = "Encode a file as base64, or decode base64 back into a file.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to encode, or the output path when decoding."),
    decode: z.string().optional().describe("Base64 payload to decode into `path`."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; decode?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string; decode?: string | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    try {
      if (input.decode !== undefined) {
        const buffer = Buffer.from(input.decode, "base64");
        ctx.backups?.save(target);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, buffer);
        return { ok: true, output: `Decoded ${buffer.length} bytes into ${toDisplayPath(ctx.cwd, target)}.` };
      }
      const buffer = await readFile(target);
      return { ok: true, output: buffer.toString("base64"), metadata: { path: target, bytes: buffer.length } };
    } catch (error) {
      return { ok: false, output: "", error: `base64_file failed: ${(error as Error).message}` };
    }
  }
}
