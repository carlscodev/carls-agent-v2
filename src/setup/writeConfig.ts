import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigFileShape, PermissionMode, ProviderName } from "../config/Config.js";
import { apiKeyEnvFor, specFor } from "../config/Config.js";

interface Args {
  out: string;
  mode?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
  effort?: string;
  contextWindow?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined) continue;
    if (value === undefined) break;
    switch (flag) {
      case "--out":
        args.out = value;
        i++;
        break;
      case "--mode":
        args.mode = value;
        i++;
        break;
      case "--model":
        args.model = value;
        i++;
        break;
      case "--base-url":
        args.baseUrl = value;
        i++;
        break;
      case "--api-key":
        args.apiKey = value;
        i++;
        break;
      case "--provider":
        args.provider = value;
        i++;
        break;
      case "--effort":
        args.effort = value;
        i++;
        break;
      case "--context-window":
        args.contextWindow = value;
        i++;
        break;
      default:
        break;
    }
  }
  if (args.out === undefined) throw new Error("--out is required");
  return args as Args;
}

/**
 * Merges installer answers into an existing config, so re-running the installer
 * never wipes settings the user added by hand.
 */
export function mergeConfig(
  existing: ConfigFileShape,
  args: {
    mode?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    provider?: string;
    effort?: string;
    contextWindow?: string;
  },
): ConfigFileShape {
  // A custom id is only accepted with an explicit base URL, so the result is
  // always usable: either a registry entry or a URL to call.
  const requested = (args.provider as ProviderName | undefined) ?? existing.provider;
  // A custom id is only accepted with a base URL to call; otherwise fall back
  // to a registry entry that the harness can reach out of the box.
  const provider: ProviderName =
    requested !== undefined && (specFor(requested) !== undefined || args.baseUrl !== undefined || existing.baseUrl !== undefined)
      ? requested
      : args.baseUrl !== undefined
        ? "openai"
        : "anthropic";
  const mode = args.mode ?? existing.mode;
  const model = args.model ?? existing.model;
  const baseUrl = args.baseUrl ?? existing.baseUrl ?? specFor(provider)?.baseUrl;
  const apiKey = args.apiKey ?? existing.apiKey;
  const effort = args.effort ?? existing.effort;

  const merged: ConfigFileShape = { provider };
  if (mode !== undefined) merged.mode = mode as PermissionMode;
  if (model !== undefined) merged.model = model;
  if (baseUrl !== undefined) merged.baseUrl = baseUrl;
  if (apiKey !== undefined) merged.apiKey = apiKey;
  if (effort !== undefined) merged.effort = effort as NonNullable<ConfigFileShape["effort"]>;
  merged.apiKeyEnv = existing.apiKeyEnv ?? apiKeyEnvFor(provider);
  merged.maxSteps = existing.maxSteps ?? 30;
  merged.maxTokens = existing.maxTokens ?? 8192;
  const contextWindow = args.contextWindow ?? existing.contextWindow;
  if (contextWindow !== undefined && existing.contextWindow !== undefined) {
    merged.contextWindow = Number(contextWindow) || existing.contextWindow;
  }
  merged.permissions = existing.permissions ?? {
    allow: ["npm test", "npm run *", "git status", "git diff *", "ls *", "node -e *"],
    deny: ["rm -rf *", "git push *", "sudo *"],
  };
  return merged;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let existing: ConfigFileShape = {};
  if (existsSync(args.out)) {
    try {
      existing = JSON.parse(readFileSync(args.out, "utf8")) as ConfigFileShape;
    } catch {
      existing = {};
    }
  }
  const merged = mergeConfig(existing, args);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  // The config may hold an API key, so keep it private.
  try {
    chmodSync(args.out, 0o600);
  } catch {
    // best effort; some filesystems do not support chmod
  }
  process.stdout.write(`${args.out}\n`);
}

if (process.argv[1] !== undefined && process.argv[1].includes("writeConfig")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`writeConfig: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
