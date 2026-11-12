import * as readline from "node:readline";
import pc from "picocolors";
import type { PermissionMode, ResolvedConfig } from "../config/Config.js";
import type { Tool, ToolCategory } from "../types/tools.js";
import type { Logger } from "../utils/Logger.js";
import { isWindows } from "../utils/platform.js";

export interface PermissionRequest {
  tool: Tool;
  input: unknown;
  preview: string;
}

export type PermissionDecision = "allow" | "deny" | "allow_always";

export type PromptFn = (question: string) => Promise<string>;

/**
 * Glob matcher supporting `*` (any run of characters) and `?` (single char).
 * Used for the bash command allow/deny lists in config.
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const flags = isWindows() ? "is" : "s";
  const regex = new RegExp(
    `^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    flags,
  );
  return regex.test(value);
}

/**
 * Normalises a command before allow/deny matching: runs of whitespace collapse
 * and, on Windows, comparison is case-insensitive. Without this, `rm   -rf /`
 * would slip past the `rm -rf *` rule.
 */
function normalizeCommand(command: string): string {
  const collapsed = command.trim().replace(/\s+/g, " ");
  return isWindows() ? collapsed.toLowerCase() : collapsed;
}

function matchesAny(patterns: string[], value: string): boolean {
  const normalized = normalizeCommand(value);
  return patterns.some((pattern) => globMatch(normalizeCommand(pattern), normalized));
}

function commandOf(input: unknown): string | undefined {
  if (input !== null && typeof input === "object" && "command" in input) {
    const value = (input as { command?: unknown }).command;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export class PermissionGate {
  private readonly alwaysAllowed = new Set<string>();
  private readonly config: ResolvedConfig;
  private readonly logger: Logger;
  private readonly prompt: PromptFn;
  private pausePromptHandler: ((paused: boolean) => void) | undefined;
  /** False when a prompt function was injected, e.g. by a test or a script. */
  private readonly usesTerminalPrompt: boolean;

  constructor(config: ResolvedConfig, logger: Logger, prompt?: PromptFn) {
    this.config = config;
    this.logger = logger;
    this.prompt = prompt ?? PermissionGate.defaultPrompt;
    this.usesTerminalPrompt = prompt === undefined;
  }

  /** The active mode; defaults to "ask" for configs built before modes existed. */
  get mode(): PermissionMode {
    return this.config.mode ?? "ask";
  }

  static categoryOf(tool: Tool): ToolCategory {
    if (tool.category !== undefined) return tool.category;
    return tool.readOnly ? "read" : "write";
  }

  /**
   * Tool-name rules from an agent preset or the config. A `deny` is checked
   * first so an allow-list can never widen it by accident.
   */
  private toolDenied(tool: Tool): boolean {
    return matchesAny(this.config.permissions.toolDeny ?? [], tool.name);
  }

  private toolAllowed(tool: Tool): boolean {
    return matchesAny(this.config.permissions.toolAllow ?? [], tool.name);
  }

  /** Read-only tools never prompt; they cannot mutate the workspace. */
  needsApproval(tool: Tool, input: unknown): boolean {
    if (tool.readOnly) return false;
    if (this.toolDenied(tool)) return true;
    if (this.toolAllowed(tool)) return false;
    if (this.alwaysAllowed.has(tool.name)) return false;
    if (PermissionGate.categoryOf(tool) === "write" && this.autoApprovesWrites()) return false;

    const command = commandOf(input);
    if (command !== undefined) {
      if (matchesAny(this.config.permissions.deny, command)) return true;
      if (matchesAny(this.config.permissions.allow, command)) return false;
      if (this.autoApprovesShell()) return false;
    }
    return true;
  }

  private autoApprovesWrites(): boolean {
    const mode = this.mode;
    return mode === "build" || mode === "auto" || mode === "yolo";
  }

  private autoApprovesShell(): boolean {
    const mode = this.mode;
    return mode === "auto" || mode === "yolo";
  }

  /**
   * Resolves whether a tool call may run, applying the mode policy:
   * - plan:  every mutating call is refused.
   * - ask:   prompt for writes and shell.
   * - build: writes run free; shell still prompts.
   * - auto:  everything runs unless the config deny-list matches.
   * - yolo:  everything runs, deny-list included.
   */
  async authorize(request: PermissionRequest): Promise<PermissionDecision> {
    const category = PermissionGate.categoryOf(request.tool);
    const mode = this.mode;
    if (category === "read") return "allow";

    const command = commandOf(request.input);
    const deniedByConfig =
      command !== undefined && matchesAny(this.config.permissions.deny, command);

    if (mode === "plan") {
      this.logger.warn(`Plan mode: blocked ${category} tool "${request.tool.name}".`);
      return "deny";
    }
    if (mode === "yolo") {
      this.logger.debug(`yolo: auto-allowing "${request.tool.name}".`);
      return "allow";
    }
    if (this.toolDenied(request.tool)) {
      process.stderr.write(pc.red(`Denied by the active agent: ${request.tool.name}\n`));
      return "deny";
    }
    if (deniedByConfig) {
      process.stderr.write(pc.red(`Denied by config deny-list: ${command}\n`));
      return "deny";
    }
    if (this.alwaysAllowed.has(request.tool.name)) return "allow";
    if (this.toolAllowed(request.tool)) {
      this.logger.debug(`allowed by the active agent: "${request.tool.name}".`);
      return "allow";
    }
    if (category === "write" && this.autoApprovesWrites()) {
      this.logger.debug(`${mode} mode: auto-allowing write "${request.tool.name}".`);
      return "allow";
    }
    if (category === "shell") {
      if (command !== undefined && matchesAny(this.config.permissions.allow, command)) {
        return "allow";
      }
      if (this.autoApprovesShell()) return "allow";
    }

    // A piped or CI run has nobody to answer, so asking would hang. Refuse and
    // say how to grant permission instead.
    if (this.usesTerminalPrompt && process.stdin.isTTY !== true) {
      process.stderr.write(
        `${pc.yellow("●")} ${request.tool.name} needs approval but stdin is not a terminal.\n` +
          `${pc.gray("  Re-run with --mode auto, or add the command to permissions.allow in .carlsrc.json.")}\n`,
      );
      return "deny";
    }

    process.stderr.write(
      `\n${pc.yellow("●")} ${pc.bold(request.tool.name)} ${pc.gray(`requires approval [${mode}]`)}\n`,
    );
    if (request.preview.length > 0) {
      process.stderr.write(`${request.preview}\n`);
    }
    // An approval prompt and the "type while it works" composer must not read
    // stdin at the same time, or answering also steers the turn.
    this.pausePromptHandler?.(true);
    let answer: string;
    try {
      answer = (await this.prompt("Allow? [y]es / [n]o / [a]lways: ")).trim().toLowerCase();
    } finally {
      this.pausePromptHandler?.(false);
    }

    if (answer === "a" || answer === "always") {
      this.alwaysAllowed.add(request.tool.name);
      return "allow_always";
    }
    if (answer === "y" || answer === "yes") return "allow";
    return "deny";
  }

  /** Lets the UI release stdin while an approval question is on screen. */
  setPromptPause(handler?: (paused: boolean) => void): void {
    this.pausePromptHandler = handler;
  }

  private static async defaultPrompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await new Promise<string>((resolve) => rl.question(question, resolve));
    } finally {
      rl.close();
    }
  }
}
