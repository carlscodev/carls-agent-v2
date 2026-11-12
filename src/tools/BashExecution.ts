import { spawn } from "node:child_process";
import { shellForPlatform } from "../utils/platform.js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";

const inputSchema = z.object({
  command: z.string().describe("Shell command to run in the workspace root."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Kill the command after this many milliseconds (default from config, 60000)."),
  description: z.string().optional().describe("Short human-readable label for the command."),
});

type Input = z.infer<typeof inputSchema>;

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
}

export class BashExecution implements Tool<Input> {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the workspace. Streams stdout/stderr live and returns the full output plus exit code. Non-zero exit codes are reported, never thrown. Uses bash on Linux and macOS, and PowerShell (or cmd.exe) on Windows.";
  readonly readOnly = false;
  readonly category = "shell" as const;

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
    const timeoutMs = input.timeout_ms ?? ctx.config.bashTimeoutMs;
    const startedAt = Date.now();
    const outcome = await this.spawnShell(input.command, ctx.cwd, timeoutMs, ctx.signal);

    if (outcome.spawnError !== undefined) {
      return { ok: false, output: "", error: `Failed to start command: ${outcome.spawnError}` };
    }

    const sections: string[] = [];
    if (outcome.stdout.length > 0) sections.push(outcome.stdout.trimEnd());
    if (outcome.stderr.length > 0) sections.push(`[stderr]\n${outcome.stderr.trimEnd()}`);
    if (outcome.timedOut) sections.push(`[timeout] Command exceeded ${timeoutMs}ms and was killed.`);
    if (outcome.signal !== null && !outcome.timedOut) {
      sections.push(`[signal] Terminated by ${outcome.signal}.`);
    }
    sections.push(`[exit code] ${outcome.exitCode ?? "null"}`);

    const ok = outcome.exitCode === 0 && !outcome.timedOut;
    const durationMs = Math.round(Date.now() - startedAt);
    const result: ToolResult = {
      ok,
      output: sections.join("\n"),
      metadata: { exitCode: outcome.exitCode, timedOut: outcome.timedOut },
    };
    if (!ok) {
      result.error =
        outcome.timedOut
          ? `Command timed out after ${timeoutMs}ms.`
          : `Command exited with code ${outcome.exitCode}.`;
    }
    return result;
  }

  private spawnShell(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      // Windows has no /bin/bash: the platform shell is cmd.exe or PowerShell.
      const shell = shellForPlatform();
      const child = spawn(shell.file, [...shell.args, command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let spawnError: string | undefined;

      const capture = (target: "out" | "err") => (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        // Live tool output is diagnostic: it always goes to stderr so that
        // stdout carries only the model's answer (safe to pipe in CI).
        if (target === "out") {
          stdout += text;
        } else {
          stderr += text;
        }
        process.stderr.write(text);
      };

      child.stdout.on("data", capture("out"));
      child.stderr.on("data", capture("err"));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const finish = (exitCode: number | null, termSignal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const outcome: SpawnOutcome = {
          stdout,
          stderr,
          exitCode,
          signal: termSignal,
          timedOut,
        };
        if (spawnError !== undefined) outcome.spawnError = spawnError;
        resolve(outcome);
      };

      child.on("error", (error) => {
        spawnError = error.message;
        finish(null, null);
      });
      child.on("close", (code, termSignal) => finish(code, termSignal));
    });
  }
}
