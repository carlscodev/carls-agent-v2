import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { providerById, PROVIDERS, type ProviderSpec } from "../providers/registry.js";
import { systemConfigPath, userConfigPath } from "../utils/platform.js";

/**
 * A provider id from the registry. Kept as a string so a user can point the
 * config at a private gateway, but every bundled id resolves to a full
 * ProviderSpec, which is what supplies the base URL, credential variable and
 * default model.
 */
export type ProviderName = string;

export { PROVIDERS };

/**
 * How destructive tool calls are authorized.
 * - plan:  read-only; every mutation is refused.
 * - ask:   prompt for each write/edit/shell call (default).
 * - build: auto-approve file edits; still prompt for shell commands.
 * - auto:  auto-approve everything not on the deny-list.
 * - yolo:  auto-approve everything, deny-list included (dangerous).
 * - pair:  like ask, but the agent opens by asking clarifying questions
 *          instead of acting, then proceeds with the answers.
 */
export type PermissionMode = "plan" | "pair" | "ask" | "build" | "auto" | "yolo";

export const PERMISSION_MODES: PermissionMode[] = ["plan", "pair", "ask", "build", "auto", "yolo"];

/** Modes cycled by Shift+Tab at the prompt, from safest to most autonomous. */
export const MODE_CYCLE: PermissionMode[] = ["plan", "pair", "ask", "build", "auto", "yolo"];

/** Reasoning effort hint forwarded to models that support it. */
export type Effort = "minimal" | "low" | "medium" | "high";

export const EFFORTS: Effort[] = ["minimal", "low", "medium", "high"];

export type { AutoUpdateMode } from "../types/update.js";
import type { AutoUpdateMode } from "../types/update.js";

export interface HooksConfig {
  preToolUse: string[];
  postToolUse: string[];
  sessionStart: string[];
  sessionEnd: string[];
  /** Runs before every tool call; can veto it or rewrite its input. */
  toolExecuteBefore: string[];
  /** Runs after every tool call; can replace the observation the model sees. */
  toolExecuteAfter: string[];
  /** Runs when a turn ends and the agent goes back to waiting for input. */
  sessionIdle: string[];
}

/**
 * The config file also accepts the dotted names the plugin API uses, so a
 * settings file written for it keeps working verbatim.
 */
export interface HooksFileShape extends Partial<HooksConfig> {
  "tool.execute.before"?: string[];
  "tool.execute.after"?: string[];
  "session.idle"?: string[];
}

/** How to start a language server for one file type (`lsp_diagnostics`). */
export interface LspServerSpec {
  command: string;
  args?: string[];
  /** LSP languageId; defaults to the extension without the dot. */
  languageId?: string;
  initOptions?: unknown;
}

export interface McpServerConfig {
  /** Local server executable (stdio transport). */
  command?: string;
  args?: string[];
  /** Extra environment (stdio) or headers/token source (remote). */
  env?: Record<string, string>;
  /** Remote endpoint. Implies the http transport unless `transport` says sse. */
  url?: string;
  /** Wire to speak with a remote endpoint. Defaults to "http". */
  transport?: "stdio" | "sse" | "http";
}

export interface ConfigFileShape {
  provider?: ProviderName;
  /** Providers the user has already configured; drives onboarding. */
  onboarded?: boolean;
  model?: string;
  mode?: PermissionMode;
  effort?: Effort;
  apiKeyEnv?: string;
  apiKey?: string;
  baseUrl?: string;
  maxSteps?: number;
  maxTokens?: number;
  contextWindow?: number;
  bashTimeoutMs?: number;
  truncateLimit?: number;
  compactThreshold?: number;
  permissions?: { allow?: string[]; deny?: string[]; toolAllow?: string[]; toolDeny?: string[] };
  hooks?: HooksFileShape;
  mcpServers?: Record<string, McpServerConfig>;
  /** Keyed by extension (".ts") or file name, e.g. "Makefile". */
  lspServers?: Record<string, LspServerSpec>;
  /** Allow tools to touch paths outside the workspace root. */
  allowOutsideWorkspace?: boolean;
  /** What to do when a newer release exists. Defaults to "auto". */
  autoUpdate?: AutoUpdateMode;
  /**
   * Tools advertised to the model. Unset means all of them, except on local
   * backends where the core set is used to keep the prompt small.
   */
  tools?: string[];
}

export interface ConfigOverrides {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
  maxTokens?: number;
  mode?: PermissionMode;
  effort?: Effort;
  /** Legacy shorthand for mode: "plan". */
  planMode?: boolean;
  /** Legacy shorthand for mode: "yolo". */
  yolo?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Comma-separated tool names from --tools. */
  tools?: string[];
}

export interface ResolvedConfig {
  provider: ProviderName;
  model: string;
  mode: PermissionMode;
  effort?: Effort;
  apiKeyEnv: string;
  /** Literal key from the config file; used only when the env var is unset. */
  apiKey?: string;
  baseUrl?: string;
  maxSteps: number;
  maxTokens: number;
  contextWindow: number;
  bashTimeoutMs: number;
  truncateLimit: number;
  compactThreshold: number;
  permissions: {
    allow: string[];
    deny: string[];
    /** Tool names that never prompt, e.g. an agent preset with `edit: allow`. */
    toolAllow?: string[];
    /** Tool names that are refused outright, e.g. `edit: deny`. */
    toolDeny?: string[];
  };
  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerSpec>;
  /** Off by default: a prompt-injected call cannot reach ~/.ssh or C:\Windows. */
  allowOutsideWorkspace: boolean;
  /** Startup release handling; see `AutoUpdateMode`. */
  autoUpdate: AutoUpdateMode;
  /** Active agent preset name, when one is loaded. */
  agentName?: string;
  /** Preset body appended to the system prompt. */
  agentPrompt?: string;
  /** Tools to advertise, or undefined for all of them. */
  tools?: string[];
  /** True when the config named a contextWindow, so discovery must not override it. */
  contextWindowPinned?: boolean;
  planMode: boolean;
  yolo: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  cwd: string;
}

const DEFAULT_HOOKS: HooksConfig = {
  preToolUse: [],
  postToolUse: [],
  sessionStart: [],
  sessionEnd: [],
  toolExecuteBefore: [],
  toolExecuteAfter: [],
  sessionIdle: [],
};

/** Credential variable for a provider id, falling back to a generic name. */
export function apiKeyEnvFor(provider: ProviderName): string {
  const spec = providerById(provider);
  if (spec !== undefined) return spec.apiKeyEnv[0] ?? "API_KEY";
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function specFor(provider: ProviderName): ProviderSpec | undefined {
  return providerById(provider);
}

function readJsonIfExists(path: string): ConfigFileShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as ConfigFileShape;
  } catch (error) {
    process.stderr.write(
      `[warn] Ignoring unreadable config at ${path}: ${(error as Error).message}\n`,
    );
    return {};
  }
}

/**
 * Precedence: CLI flags > ./.carlsrc.json > ~/.carlsrc.json >
 * /etc/carls/.carlsrc.json (or $CARLS_SYSTEM_CONFIG) > built-in defaults.
 */
export function loadConfig(overrides: ConfigOverrides = {}, cwd = process.cwd()): ResolvedConfig {
  const systemPath = process.env.CARLS_SYSTEM_CONFIG ?? systemConfigPath();
  const systemCfg = readJsonIfExists(systemPath);
  const globalCfg = readJsonIfExists(userConfigPath());
  const localPath = join(cwd, ".carlsrc.json");
  const localCfg = readJsonIfExists(localPath);
  const file: ConfigFileShape = { ...systemCfg, ...globalCfg, ...localCfg };
  // The layer that actually supplied the key is the one whose permissions matter.
  const keySourcePath =
    localCfg.apiKey !== undefined
      ? localPath
      : globalCfg.apiKey !== undefined
        ? userConfigPath()
        : systemPath;

  const provider = overrides.provider ?? file.provider ?? "anthropic";
  const model = overrides.model ?? file.model ?? defaultModelFor(provider);
  const baseUrl = overrides.baseUrl ?? file.baseUrl ?? specFor(provider)?.baseUrl;
  const mode = resolveMode(overrides, file);

  const resolved: ResolvedConfig = {
    provider,
    model,
    mode,
    apiKeyEnv: file.apiKeyEnv ?? apiKeyEnvFor(provider),
    maxSteps: overrides.maxSteps ?? file.maxSteps ?? 30,
    maxTokens: overrides.maxTokens ?? file.maxTokens ?? 8192,
    contextWindow: file.contextWindow ?? specFor(provider)?.contextWindow ?? 200000,
    bashTimeoutMs: file.bashTimeoutMs ?? 60000,
    truncateLimit: file.truncateLimit ?? 8000,
    compactThreshold: file.compactThreshold ?? 0.75,
    permissions: {
      allow: file.permissions?.allow ?? [],
      deny: file.permissions?.deny ?? [],
      ...(file.permissions?.toolAllow !== undefined ? { toolAllow: file.permissions.toolAllow } : {}),
      ...(file.permissions?.toolDeny !== undefined ? { toolDeny: file.permissions.toolDeny } : {}),
    },
    hooks: {
      ...DEFAULT_HOOKS,
      ...file.hooks,
      toolExecuteBefore: file.hooks?.toolExecuteBefore ?? file.hooks?.["tool.execute.before"] ?? [],
      toolExecuteAfter: file.hooks?.toolExecuteAfter ?? file.hooks?.["tool.execute.after"] ?? [],
      sessionIdle: file.hooks?.sessionIdle ?? file.hooks?.["session.idle"] ?? [],
    },
    mcpServers: file.mcpServers ?? {},
    ...(file.lspServers !== undefined ? { lspServers: file.lspServers } : {}),
    allowOutsideWorkspace: file.allowOutsideWorkspace ?? process.env.CARLS_ALLOW_OUTSIDE === "1",
    // Anything that is not one of the two conservative modes keeps the default:
    // a typo must not silently disable updates, nor make them more aggressive.
    autoUpdate: file.autoUpdate === "notify" || file.autoUpdate === "off" ? file.autoUpdate : "auto",
    contextWindowPinned: file.contextWindow !== undefined,
    planMode: false,
    yolo: false,
    logLevel: overrides.logLevel ?? "info",
    cwd,
  };
  if (baseUrl !== undefined) resolved.baseUrl = baseUrl;
  if (file.apiKey !== undefined) resolved.apiKey = file.apiKey;
  const tools = overrides.tools ?? file.tools;
  if (tools !== undefined && tools.length > 0) resolved.tools = tools;
  // A config file other people can read is a leaked key. Warn the human at the
  // terminal; stay silent in pipes and CI, where the line is only noise.
  if (file.apiKey !== undefined && process.platform !== "win32" && process.stderr.isTTY === true) {
    try {
      const mode = statSync(keySourcePath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        process.stderr.write(
          `warning: ${keySourcePath} is mode ${mode.toString(8)} and holds an API key.\n` +
            `         Run: chmod 600 ${keySourcePath} (or set the key in the environment).\n`,
        );
      }
    } catch {
      // The path may be a symlink whose target vanished; nothing to warn about.
    }
  }
  const effort = overrides.effort ?? file.effort;
  if (effort !== undefined) resolved.effort = effort;
  return resolved;
}

/**
 * CLI flags win over the config file. The legacy booleans are folded in so old
 * configs and scripts keep working.
 */
function resolveMode(overrides: ConfigOverrides, file: ConfigFileShape): PermissionMode {
  if (overrides.mode !== undefined) return overrides.mode;
  if (overrides.planMode === true) return "plan";
  if (overrides.yolo === true) return "yolo";
  if (file.mode !== undefined) return file.mode;
  return "ask";
}

export function defaultModelFor(provider: ProviderName): string {
  return specFor(provider)?.defaultModel ?? "gpt-4o";
}

/**
 * True when the provider id is a bundled one, or when it is a custom id that
 * carries its own base URL (which is what makes a private gateway usable).
 */
export function isKnownProvider(provider: ProviderName): boolean {
  return providerById(provider) !== undefined;
}

/** Providers a keyless backend can run without credentials. */
export function isKeylessProvider(provider: ProviderName): boolean {
  return specFor(provider)?.keyless === true;
}
