import { spawn } from "node:child_process";
import type { HooksConfig } from "../config/Config.js";
import type { Logger } from "../utils/Logger.js";
import { shellForPlatform } from "../utils/platform.js";

export interface HookContext {
  toolName?: string;
  input?: unknown;
  result?: { ok: boolean; output: string };
}

export interface PreToolUseDecision {
  block: boolean;
  reason?: string;
}

export interface ToolBeforeDecision extends PreToolUseDecision {
  /** Replacement input from the hook, already validated by the caller. */
  input?: unknown;
}

const HOOK_TIMEOUT_MS = 30000;

/**
 * Shell hooks loaded from .carlsrc.json. Hooks receive JSON on stdin and may
 * return JSON on stdout.
 *
 * Two events can change behaviour, the way the plugin API's
 * `tool.execute.before/after` can: exit code 2 (or `{"block": true}`) aborts a
 * tool call, `{"input": {...}}` (or `{"args": {...}}`) replaces its input, and
 * `{"output": "..."}` replaces the observation the model reads.
 */
export class Hooks {
  private readonly config: HooksConfig;
  private readonly logger: Logger;
  private readonly cwd: string;

  constructor(config: HooksConfig, logger: Logger, cwd: string) {
    this.config = config;
    this.logger = logger;
    this.cwd = cwd;
  }

  private async runCommands(commands: string[], payload: unknown): Promise<{ code: number; stdout: string }[]> {
    const results: { code: number; stdout: string }[] = [];
    for (const command of commands) {
      results.push(await this.runOne(command, payload));
    }
    return results;
  }

  private runOne(command: string, payload: unknown): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
      const shell = shellForPlatform();
      // PowerShell returns 1 for any failing native command unless the command
      // ends with `exit $LASTEXITCODE`; preserving code 2 is what lets a hook
      // veto a tool call on Windows exactly as it does on POSIX.
      const commandText = `${command}${shell.commandSuffix ?? ""}`;
      const child = spawn(shell.file, [...shell.args, commandText], {
        cwd: this.cwd,
        env: { ...process.env, CARLS_HOOK: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

      const timer = setTimeout(() => child.kill("SIGKILL"), HOOK_TIMEOUT_MS);

      child.on("error", (error) => {
        clearTimeout(timer);
        this.logger.warn(`hook "${command}" failed to start: ${error.message}`);
        resolve({ code: 1, stdout: "" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stderr.length > 0) this.logger.debug(`hook stderr: ${stderr.trim()}`);
        resolve({ code: code ?? 1, stdout });
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  async preToolUse(context: HookContext): Promise<PreToolUseDecision> {
    if (this.config.preToolUse.length === 0) return { block: false };
    const results = await this.runCommands(this.config.preToolUse, {
      event: "pre_tool_use",
      ...context,
    });
    for (const result of results) {
      if (result.code === 2) {
        return { block: true, reason: result.stdout.trim() || "blocked by preToolUse hook" };
      }
      const trimmed = result.stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as { block?: boolean; reason?: string };
          if (parsed.block === true) {
            const decision: PreToolUseDecision = { block: true };
            if (parsed.reason !== undefined) decision.reason = parsed.reason;
            return decision;
          }
        } catch {
          // Non-JSON hook output is informational only.
        }
      }
    }
    return { block: false };
  }

  async postToolUse(context: HookContext): Promise<void> {
    if (this.config.postToolUse.length === 0) return;
    await this.runCommands(this.config.postToolUse, { event: "post_tool_use", ...context });
  }

  private static parseJson(stdout: string): Record<string, unknown> | undefined {
    const trimmed = stdout.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      // Non-JSON hook output is informational only.
      return undefined;
    }
  }

  /**
   * `preToolUse` and `tool.execute.before` run in that order; each hook sees the
   * input as the previous one left it, so a chain can narrow a call step by step.
   */
  async toolBefore(context: HookContext): Promise<ToolBeforeDecision> {
    let input = context.input;
    let blocked: ToolBeforeDecision | undefined;

    const runList = async (commands: string[], event: string): Promise<void> => {
      for (const command of commands) {
        if (blocked !== undefined) return;
        const result = await this.runOne(command, { event, ...context, input });
        const parsed = Hooks.parseJson(result.stdout);
        if (result.code === 2 || parsed?.block === true) {
          const reason = typeof parsed?.reason === "string" ? parsed.reason : result.stdout.trim();
          blocked = { block: true, input };
          const finalReason = reason.length > 0 ? reason : `blocked by ${event} hook`;
          blocked.reason = finalReason;
          return;
        }
        const replacement = parsed?.input ?? parsed?.args;
        if (replacement !== undefined) input = replacement;
      }
    };

    await runList(this.config.preToolUse, "pre_tool_use");
    await runList(this.config.toolExecuteBefore, "tool.execute.before");
    if (blocked !== undefined) return blocked;
    return { block: false, input };
  }

  /**
   * `postToolUse` and `tool.execute.after` run in that order. The last
   * `{"output": "..."}` wins, which is how a plugin hides noise from the model.
   */
  async toolAfter(context: HookContext): Promise<{ output?: string }> {
    let output: string | undefined;
    const runList = async (commands: string[], event: string): Promise<void> => {
      for (const command of commands) {
        const result = await this.runOne(command, { event, ...context });
        const parsed = Hooks.parseJson(result.stdout);
        if (typeof parsed?.output === "string") output = parsed.output;
      }
    };
    await runList(this.config.postToolUse, "post_tool_use");
    await runList(this.config.toolExecuteAfter, "tool.execute.after");
    return output === undefined ? {} : { output };
  }

  /** Fired when a turn ends and the agent is idle again. */
  async sessionIdle(payload: unknown = {}): Promise<void> {
    if (this.config.sessionIdle.length === 0) return;
    await this.runCommands(this.config.sessionIdle, { event: "session.idle", ...(payload as Record<string, unknown>) });
  }

  async sessionStart(payload: unknown = {}): Promise<void> {
    if (this.config.sessionStart.length === 0) return;
    await this.runCommands(this.config.sessionStart, { event: "session_start", ...(payload as Record<string, unknown>) });
  }

  async sessionEnd(payload: unknown = {}): Promise<void> {
    if (this.config.sessionEnd.length === 0) return;
    await this.runCommands(this.config.sessionEnd, { event: "session_end", ...(payload as Record<string, unknown>) });
  }
}
