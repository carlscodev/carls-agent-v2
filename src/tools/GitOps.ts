import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { splitLines } from "../utils/eol.js";
import { run } from "./helpers.js";

interface GitOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number | undefined;
}

async function git(args: string[], options: GitOptions): Promise<ToolResult> {
  const outcome = await run("git", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal,
  });
  if (outcome.spawnError !== undefined) {
    return { ok: false, output: "", error: `git is not available: ${outcome.spawnError}` };
  }
  const body = [outcome.stdout.trimEnd(), outcome.stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
  return {
    ok: outcome.exitCode === 0,
    output: body.length > 0 ? body : "(no output)",
    ...(outcome.exitCode === 0 ? {} : { error: `git ${args[0]} exited ${outcome.exitCode}` }),
    metadata: { exitCode: outcome.exitCode, durationMs: outcome.durationMs },
  };
}

export class GitStatus implements Tool<{porcelain?: boolean  | undefined}> {
  readonly name = "git_status";
  readonly description = "Show the working tree status: branch, staged changes and untracked files.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    porcelain: z.boolean().optional().describe("Machine-readable short output."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { porcelain?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {porcelain?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const args = input.porcelain === true ? ["status", "--short", "--branch"] : ["status", "--short", "--branch", "--untracked-files=all"];
    return git(args, { cwd: ctx.cwd, signal: ctx.signal });
  }
}

export class GitDiff implements Tool<{path?: string | undefined; staged?: boolean | undefined; stat?: boolean  | undefined}> {
  readonly name = "git_diff";
  readonly description = "Show the diff of unstaged or staged changes, optionally for one path.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().optional().describe("Limit the diff to this path."),
    staged: z.boolean().optional().describe("Diff the index instead of the working tree."),
    stat: z.boolean().optional().describe("Show a summary instead of the full diff."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path?: string | undefined ; staged?: boolean | undefined ; stat?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path?: string | undefined; staged?: boolean | undefined; stat?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const args = ["diff", "--no-color"];
    if (input.staged === true) args.push("--staged");
    if (input.stat === true) args.push("--stat");
    if (input.path !== undefined) args.push("--", input.path);
    const result = await git(args, { cwd: ctx.cwd, signal: ctx.signal });
    if (result.ok && result.output.trim().length === 0) {
      return { ok: true, output: "(no changes)" };
    }
    return result;
  }
}

export class GitLog implements Tool<{limit?: number | undefined; path?: string | undefined; since?: string  | undefined}> {
  readonly name = "git_log";
  readonly description = "Show recent commits, optionally filtered by path or date.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    limit: z.number().int().min(1).max(100).optional().describe("Number of commits, default 15."),
    path: z.string().optional().describe("Only commits touching this path."),
    since: z.string().optional().describe("Only commits after this date, e.g. 2 weeks ago."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { limit?: number | undefined ; path?: string | undefined ; since?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {limit?: number | undefined; path?: string | undefined; since?: string | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const args = ["log", "--oneline", "--decorate", `-n${input.limit ?? 15}`];
    if (input.since !== undefined) args.push(`--since=${input.since}`);
    if (input.path !== undefined) args.push("--", input.path);
    return git(args, { cwd: ctx.cwd, signal: ctx.signal });
  }
}

export class GitBlame implements Tool<{path: string; start?: number | undefined; end?: number  | undefined}> {
  readonly name = "git_blame";
  readonly description = "Show which commit last touched each line of a range. Use to find the origin of a change.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("File to blame."),
    start: z.number().int().positive().optional().describe("First line, 1-based."),
    end: z.number().int().positive().optional().describe("Last line."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; start?: number | undefined ; end?: number  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string; start?: number | undefined; end?: number | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const args = ["blame", "-w", "--date=short"];
    if (input.start !== undefined) args.push(`-L${input.start},${input.end ?? input.start}`);
    args.push("--", input.path);
    return git(args, { cwd: ctx.cwd, signal: ctx.signal });
  }
}

export class GitBranch implements Tool<{create?: string | undefined; checkout?: string | undefined; list?: boolean  | undefined}> {
  readonly name = "git_branch";
  readonly description = "List branches, or create and switch to one. Never deletes or force-updates a branch.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    create: z.string().optional().describe("Name of a new branch to create and switch to."),
    checkout: z.string().optional().describe("Existing branch to switch to."),
    list: z.boolean().optional().describe("List branches."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { create?: string | undefined ; checkout?: string | undefined ; list?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {create?: string | undefined; checkout?: string | undefined; list?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    if (input.create !== undefined) {
      return git(["switch", "-c", input.create], { cwd: ctx.cwd, signal: ctx.signal });
    }
    if (input.checkout !== undefined) {
      return git(["switch", input.checkout], { cwd: ctx.cwd, signal: ctx.signal });
    }
    return git(["branch", "-vv", "--sort=-committerdate"], { cwd: ctx.cwd, signal: ctx.signal });
  }
}

export class GitCommit implements Tool<{message: string; paths?: string[] | undefined; all?: boolean  | undefined}> {
  readonly name = "git_commit";
  readonly description =
    "Stage files and create a commit. Never pushes and never amends. Requires an explicit message.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    message: z.string().describe("Commit message. Use the imperative mood."),
    paths: z.array(z.string()).optional().describe("Files to stage. Omit with all:true to stage tracked changes."),
    all: z.boolean().optional().describe("Stage all tracked modifications."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { message: string; paths?: string[] | undefined ; all?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {message: string; paths?: string[] | undefined; all?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    if (input.paths !== undefined && input.paths.length > 0) {
      const add = await git(["add", "--", ...input.paths], { cwd: ctx.cwd, signal: ctx.signal });
      if (!add.ok) return add;
    } else if (input.all === true) {
      const add = await git(["add", "-u"], { cwd: ctx.cwd, signal: ctx.signal });
      if (!add.ok) return add;
    }
    const staged = await git(["diff", "--cached", "--name-only"], { cwd: ctx.cwd, signal: ctx.signal });
    if (staged.ok && staged.output.trim().length === 0) {
      return { ok: false, output: "", error: "Nothing is staged. Stage files with paths or all:true." };
    }
    const result = await git(["commit", "-m", input.message], { cwd: ctx.cwd, signal: ctx.signal });
    if (result.ok) {
      const head = await git(["rev-parse", "--short", "HEAD"], { cwd: ctx.cwd, signal: ctx.signal });
      return { ok: true, output: `${result.output}\n${head.output.trim()}`, metadata: { sha: head.output.trim() } };
    }
    return result;
  }
}

export class SecretScan implements Tool<{path?: string | undefined; limit?: number  | undefined}> {
  readonly name = "secret_scan";
  readonly description =
    "Scan tracked files for likely secrets (API keys, tokens, private keys). Run before committing or opening a pull request.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    path: z.string().optional().describe("Directory or file to scan, defaults to the workspace."),
    limit: z.number().int().positive().max(200).optional().describe("Maximum findings to report."),
  });
  private static readonly PATTERNS: [string, RegExp][] = [
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
    ["openai key", /sk-[A-Za-z0-9]{20,}/],
    ["aws access key", /AKIA[0-9A-Z]{16}/],
    ["github token", /gh[pousr]_[A-Za-z0-9]{20,}/],
    ["google api key", /AIza[0-9A-Za-z_-]{35}/],
    ["slack token", /xox[abpsr]-[A-Za-z0-9-]{10,}/],
    ["generic assignment", /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i],
  ];

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path?: string | undefined ; limit?: number  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path?: string | undefined; limit?: number | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const outcome = await run(
      "grep",
      ["-rInE", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist", "-e", "-----BEGIN", "-e", "sk-ant-", "-e", "AKIA[0-9A-Z]{16}", "-e", "gh[pousr]_[A-Za-z0-9]{20,}", "-e", "AIza[0-9A-Za-z_-]{35}", "--", input.path ?? "."],
      { cwd: ctx.cwd, timeoutMs: 30_000, signal: ctx.signal },
    );
    const lines = splitLines(outcome.stdout).filter((line) => line.trim().length > 0);
    const limit = input.limit ?? 40;
    const findings: string[] = [];
    for (const line of lines.slice(0, limit)) {
      const matched = SecretScan.PATTERNS.find(([, pattern]) => pattern.test(line));
      const label = matched?.[0] ?? "possible secret";
      findings.push(`[${label}] ${line.slice(0, 200)}`);
    }
    if (findings.length === 0) {
      return { ok: true, output: "No obvious secrets found.", metadata: { findings: 0 } };
    }
    return {
      ok: true,
      output: `${findings.length} possible secret${findings.length === 1 ? "" : "s"}:\n${findings.join("\n")}`,
      metadata: { findings: findings.length },
    };
  }
}
