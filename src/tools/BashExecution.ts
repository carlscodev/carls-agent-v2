import { spawn } from "node:child_process";
import { isWindows, shellForPlatform } from "../utils/platform.js";
import {
  detectOsProfile,
  killProcessTree,
  needsDetachedGroup,
  utf8Env,
  verifyCwdIntegrity,
} from "../os/OsRuntimeAdapter.js";
import {
  planDirectWindowsCommand,
  utf8PreludeForShell,
} from "../os/WindowsCompat.js";
import { sandboxCommand } from "../os/Sandbox.js";
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
  sandbox: z
    .boolean()
    .optional()
    .describe(
      "Run inside the host's sandbox when one is available (bubblewrap on Linux/Android, sandbox-exec on macOS). Ignored where none exists.",
    ),
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
    const outcome = await this.spawnShell(input.command, ctx.cwd, timeoutMs, ctx.signal, input.sandbox === true);

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

    // The command ran; the session root is checked before the next one does, so
    // a `rm -rf .` or a `mv` of the workspace is reported once, in plain words,
    // instead of surfacing as an ENOENT from an unrelated later tool.
    const integrity = verifyCwdIntegrity(ctx.cwd);
    if (!integrity.ok) {
      sections.push(`[workspace] ${integrity.reason}: ${integrity.path}`);
    }

    const ok = outcome.exitCode === 0 && !outcome.timedOut;
    const durationMs = Math.round(Date.now() - startedAt);
    const result: ToolResult = {
      ok: ok && integrity.ok,
      output: sections.join("\n"),
      metadata: {
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        cwdIntact: integrity.ok,
        durationMs,
      },
    };
    if (!ok) {
      result.error =
        outcome.timedOut
          ? `Command timed out after ${timeoutMs}ms.`
          : `Command exited with code ${outcome.exitCode}.`;
    } else if (!integrity.ok) {
      result.error = `The workspace root was damaged by the command: ${integrity.reason}.`;
    }
    return result;
  }

  private spawnShell(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
    sandboxed: boolean,
  ): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      // Windows has no /bin/bash: the platform shell is cmd.exe or PowerShell.
      const shell = shellForPlatform();
      const commandText = `${utf8PreludeForShell(shell.file)}${command}${shell.commandSuffix ?? ""}`;

      // A simple invocation of a real executable does not need an intermediate
      // shell on Windows. Bypassing PowerShell removes a process launch, a
      // quoting layer and its exit-code quirks from every `git status`.
      const direct =
        isWindows() && !sandboxed
          ? planDirectWindowsCommand(command, { cwd, env: process.env })
          : undefined;
      const useDirect = direct?.launcher === "direct";

      const wrapped =
        !useDirect && sandboxed ? sandboxCommand(shell.file, shell.args, commandText, cwd) : undefined;
      const file = useDirect && direct !== undefined ? direct.file : (wrapped?.file ?? shell.file);
      const args =
        useDirect && direct !== undefined ? direct.args : (wrapped?.args ?? [...shell.args, commandText]);
      // UTF-8 is forced so a non-English locale cannot corrupt the observation.
      // The shell prologue above covers the inherited console; the environment
      // covers Python and anything else that only reads its own variables.
      const childEnv = isWindows() ? { ...process.env, ...utf8Env() } : { ...process.env, ...detectOsProfile().env };

      const child = spawn(file, args, {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // A detached POSIX child leads its own process group, which is what
        // makes the negative-pid kill below reach its grandchildren.
        detached: needsDetachedGroup(),
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

      const killTree = (sig: NodeJS.Signals): void => {
        killProcessTree(child.pid, sig);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGKILL");
      }, timeoutMs);

      const onAbort = (): void => {
        killTree("SIGTERM");
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
