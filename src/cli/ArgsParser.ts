import type { ConfigOverrides, Effort, PermissionMode, ProviderName } from "../config/Config.js";
import { EFFORTS, PERMISSION_MODES } from "../config/Config.js";
import { providerById } from "../providers/registry.js";

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  query?: string;
  resume?: string | "latest";
  overrides: ConfigOverrides;
  /** True when the query was supplied via -p/--print. */
  printMode: boolean;
  /** Run the setup wizard before anything else. */
  setup: boolean;
  /** List providers and exit. */
  listProviders: boolean;
  /** Print the diagnostic panel and exit. */
  doctor: boolean;
  /** API key supplied on the command line (setup only; prefer the env var). */
  apiKey?: string;
}

export class ArgError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    version: false,
    overrides: {},
    printMode: false,
    setup: false,
    listProviders: false,
    doctor: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    const next = (name: string): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ArgError(`Flag ${name} requires a value.`);
      }
      i++;
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-v":
      case "--version":
        parsed.version = true;
        break;
      case "-p":
      case "--print":
        parsed.printMode = true;
        positionals.push(next(arg));
        break;
      case "--plan":
        parsed.overrides.mode = "plan";
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        parsed.overrides.mode = "yolo";
        break;
      case "-m":
      case "--mode": {
        const value = next(arg);
        if (!PERMISSION_MODES.includes(value as PermissionMode)) {
          throw new ArgError(`Unknown mode "${value}". Use one of: ${PERMISSION_MODES.join(", ")}.`);
        }
        parsed.overrides.mode = value as PermissionMode;
        break;
      }
      case "--effort": {
        const value = next(arg);
        if (!EFFORTS.includes(value as Effort)) {
          throw new ArgError(`Unknown effort "${value}". Use one of: ${EFFORTS.join(", ")}.`);
        }
        parsed.overrides.effort = value as Effort;
        break;
      }
      case "--max-steps":
        parsed.overrides.maxSteps = parsePositiveInt(next(arg), arg);
        break;
      case "--max-tokens":
        parsed.overrides.maxTokens = parsePositiveInt(next(arg), arg);
        break;
      case "--model":
        parsed.overrides.model = next(arg);
        break;
      case "--provider": {
        const value = next(arg);
        const known = providerById(value);
        if (known === undefined && !value.includes(".") && !value.includes(":")) {
          throw new ArgError(
            `Unknown provider "${value}". Run carls --providers to list the bundled ids, ` +
              `or pass a custom id together with --base-url.`,
          );
        }
        parsed.overrides.provider = value as ProviderName;
        break;
      }
      case "--setup":
      case "--configure":
        parsed.setup = true;
        break;
      case "--providers":
      case "--list-providers":
        parsed.listProviders = true;
        break;
      case "--doctor":
        parsed.doctor = true;
        break;
      case "--api-key":
        parsed.apiKey = next(arg);
        parsed.setup = true;
        break;
      case "--tools": {
        parsed.overrides.tools = next(arg)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        break;
      }
      case "--base-url":
        parsed.overrides.baseUrl = next(arg);
        break;
      case "--debug":
        parsed.overrides.logLevel = "debug";
        break;
      case "--resume": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          parsed.resume = "latest";
        } else {
          parsed.resume = value;
          i++;
        }
        break;
      }
      default:
        if (arg.startsWith("--")) {
          throw new ArgError(`Unknown flag "${arg}". Run carls --help.`);
        }
        positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    parsed.query = positionals.join(" ");
  }
  return parsed;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ArgError(`${flag} expects a positive integer, got "${value}".`);
  }
  return parsed;
}

export const HELP_TEXT = `carls-code — autonomous AI coding agent harness

USAGE
  carls                       Start the interactive REPL
  carls "query"               Run one query, then exit
  carls -p "query"            Same as above (print mode)
  carls --resume [id]         Resume the latest session (or one by id)

OPTIONS
  -h, --help                  Show this help
  -v, --version               Show version
  -p, --print <query>         One-shot, non-interactive run
  -m, --mode <mode>           plan | ask | build | auto | yolo (default ask)
      --plan                  Shorthand for --mode plan
      --yolo                  Shorthand for --mode yolo
      --dangerously-skip-permissions
                              Alias of --yolo
      --effort <level>        minimal | low | medium | high
      --max-steps <n>         Max agent steps per turn (default 30)
      --max-tokens <n>        Max output tokens per model call (default 8192)
      --model <name>          Override the model
      --provider <name>       Provider id (see --providers); defaults to anthropic
      --base-url <url>        Override the provider base URL
      --tools <a,b,c>         Tools advertised to the model (local backends
                              default to the core set to save context)
      --setup, --configure    Run the first-time setup wizard
      --api-key <key>         Key for the setup wizard (prefer the env var)
      --providers             List every bundled provider and exit
      --doctor                Check config, credentials and connectivity, then exit
      --debug                 Verbose diagnostics on stderr

MODES
  plan    read-only; every write or shell call is refused
  ask     prompt before writes and shell commands (default)
  build   auto-approve file edits; shell commands still prompt
  auto    auto-approve everything except the config deny-list
  yolo    auto-approve everything, deny-list included (dangerous)

LOCAL MODELS
  Ollama, LM Studio, vLLM and llama.cpp need no API key. Ollama is spoken
  natively, so the real context window and tool support are read from the
  server and num_ctx is set for you. Start one, then:

    carls --provider ollama --model qwen3-coder:30b
    carls --provider lmstudio --model local-model
    carls --provider vllm --base-url http://localhost:8000/v1 --model <id>

ENVIRONMENT
  Every provider reads its own variable: ANTHROPIC_API_KEY, OPENAI_API_KEY,
  OPENROUTER_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
  DEEPSEEK_API_KEY, XAI_API_KEY, MISTRAL_API_KEY, TOGETHER_API_KEY and so on.
  Run carls --providers to see the full list. A config-file "apiKey" also works.

REPL COMMANDS
  /help      /models [filter]   /model <id>    /effort <level>
  /mode      /status            /cost          /context
  /tools     /diff              /sessions      /resume <id>
  /compact   /clear             /retry         /doctor
  /config    /permissions       /init          /exit
  /setup     /providers         /skills        /todo
  !<command>  run a shell command in the workspace
`;
