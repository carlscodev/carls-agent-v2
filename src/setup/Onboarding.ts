import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as readline from "node:readline";
import pc from "picocolors";
import type { ConfigFileShape, Effort, PermissionMode, ResolvedConfig } from "../config/Config.js";
import { EFFORTS, MODE_CYCLE, apiKeyEnvFor, defaultModelFor } from "../config/Config.js";
import { providersByFamily, providerById, PROVIDERS, type ProviderSpec } from "../providers/registry.js";
import { fetchModels, knownModelsFor, type ModelInfo } from "../models/Catalog.js";
import { RawSession } from "../cli/Input.js";
import { isWindows, userConfigPath } from "../utils/platform.js";
import { redact } from "../utils/Logger.js";

export interface OnboardingOptions {
  /** Where the answers are written. Defaults to the user-level config. */
  outPath?: string;
  /** Skips prompts that already have an answer (used by --setup flags). */
  preset?: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    mode?: PermissionMode;
    effort?: Effort;
  };
  /**
   * Provider to highlight when the wizard asks. It is a default, not a
   * decision: the question is still asked, so `/setup` can switch providers.
   */
  defaultProvider?: string;
  /** Model to offer first when the wizard asks. Same "default, not decision" rule. */
  defaultModel?: string;
  /**
   * Skip the live request that verifies the credential and lists models. Setup
   * then works offline and in tests, both of which must not depend on someone
   * else's network answering.
   */
  offline?: boolean;
  /** Open the provider's key page in a browser when the user chooses sign-in. */
  openBrowser?: (url: string) => void;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export interface OnboardingResult {
  configPath: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
  /** True when a key was written into the config file. */
  storedKey: boolean;
  cancelled: boolean;
}

const MODE_NOTES: Record<PermissionMode, string> = {
  plan: "read-only; the agent proposes a plan and changes nothing",
  pair: "asks clarifying questions first, then works with you",
  ask: "asks before every write and shell command",
  build: "edits files freely, still asks before shell commands",
  auto: "works unattended, blocking only the deny-list",
  yolo: "never asks; only for disposable sandboxes",
};

/**
 * Line input for the wizard. A terminal gets one prompt per question; a pipe
 * or a file is read once and served in order, so `printf "..." | carls --setup`
 * is deterministic instead of depending on readline buffering.
 */
class LineSource {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private queue: string[] | undefined;
  private cursor = 0;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    this.input = input;
    this.output = output;
  }

  private async preload(): Promise<void> {
    if (this.queue !== undefined) return;
    const lines: string[] = [];
    const rl = readline.createInterface({ input: this.input, terminal: false });
    await new Promise<void>((resolve) => {
      rl.on("line", (line) => lines.push(line));
      rl.on("close", () => resolve());
    });
    this.queue = lines;
  }

  async ask(question: string): Promise<string | undefined> {
    if (this.input.isTTY === true) {
      const rl = readline.createInterface({ input: this.input, output: this.output, terminal: true });
      try {
        return await new Promise<string | undefined>((resolve) => {
          let settled = false;
          const finish = (value: string | undefined): void => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          rl.question(question, (answer) => finish(answer));
          rl.on("close", () => finish(undefined));
        });
      } finally {
        rl.close();
      }
    }

    await this.preload();
    this.output.write(question);
    const value = this.queue?.[this.cursor];
    this.cursor += 1;
    if (value === undefined) {
      this.output.write("\n");
      return undefined;
    }
    this.output.write(`${value}\n`);
    return value;
  }
}

/** Reads a secret without echoing it. Falls back to a visible prompt off-TTY. */
async function askSecret(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  question: string,
  source: LineSource,
): Promise<string | undefined> {
  if (input.isTTY !== true) return source.ask(question);

  output.write(question);
  const wasRaw = input.isRaw === true;
  input.setRawMode?.(true);
  input.resume();
  readline.emitKeypressEvents(input);

  return new Promise<string | undefined>((resolve) => {
    let buffer = "";
    const onKey = (_str: string | undefined, key: readline.Key): void => {
      if (key.ctrl === true && key.name === "c") {
        cleanup();
        output.write("\n");
        resolve(undefined);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(buffer.trim());
        return;
      }
      if (key.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      if (key.sequence !== undefined && key.sequence.length === 1 && !key.ctrl) {
        buffer += key.sequence;
        output.write("*");
      }
    };
    const cleanup = (): void => {
      input.off("keypress", onKey);
      if (input.setRawMode) input.setRawMode(wasRaw);
      input.pause();
    };
    input.on("keypress", onKey);
  });
}

interface Choice<T> {
  label: string;
  value: T;
  note?: string;
  group?: string;
}

/**
 * Arrow-key picker. Returns the highlighted value on Enter and undefined on
 * cancel or EOF. When stdin is not a terminal the caller supplies a fallback.
 */
async function choose<T>(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  title: string,
  choices: Choice<T>[],
  pageSize = 14,
  initialIndex = 0,
): Promise<T | undefined> {
  if (input.isTTY !== true || choices.length === 0) return undefined;
  let index = Math.min(Math.max(0, initialIndex), choices.length - 1);
  let offset = Math.max(0, index - pageSize + 1);

  return RawSession.with(input, async (next) => {
    const draw = (): number => {
      const rows: string[] = [pc.bold(title), pc.gray("↑/↓ move · Enter select · q cancel"), ""];
      const slice = choices.slice(offset, offset + pageSize);
      let lastGroup: string | undefined;
      for (let i = 0; i < slice.length; i++) {
        const choice = slice[i];
        if (choice === undefined) continue;
        if (choice.group !== undefined && choice.group !== lastGroup) {
          rows.push(pc.gray(`  ${choice.group}`));
          lastGroup = choice.group;
        }
        const active = offset + i === index;
        const label = active ? pc.cyan(choice.label) : choice.label;
        const note = choice.note !== undefined ? pc.gray(`  ${choice.note}`) : "";
        rows.push(`${active ? pc.cyan("▸") : " "} ${label}${note}`);
      }
      if (choices.length > pageSize) {
        rows.push(pc.gray(`  ${offset + 1}-${Math.min(offset + pageSize, choices.length)} of ${choices.length}`));
      }
      output.write(`${rows.join("\n")}\n`);
      return rows.length;
    };

    let drawn = 0;
    const redraw = (): void => {
      if (drawn > 0) output.write(`\u001b[${drawn}A`);
      const now = draw();
      for (let i = now; i < drawn; i++) output.write("\u001b[2K\n");
      if (now < drawn) output.write(`\u001b[${drawn - now}A`);
      drawn = Math.max(now, drawn);
    };
    redraw();

    for (;;) {
      const key = await next();
      if (key.name === "up" || key.name === "k") index = (index - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j") index = (index + 1) % choices.length;
      else if (key.name === "return" || key.name === "enter") {
        output.write("\n");
        return choices[index]?.value;
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl === true && key.name === "c")) {
        output.write("\n");
        return undefined;
      }
      if (index < offset) offset = index;
      if (index >= offset + pageSize) offset = index - pageSize + 1;
      redraw();
    }
  });
}

function heading(output: NodeJS.WriteStream, title: string, subtitle?: string): void {
  const width = Math.min(72, output.columns ?? 72);
  output.write(`\n${pc.bold(pc.cyan(title))}\n`);
  output.write(`${pc.gray("─".repeat(Math.max(8, width)))}\n`);
  if (subtitle !== undefined) output.write(`${pc.gray(subtitle)}\n`);
  output.write("\n");
}

/** Reads a provider spec from an id, tolerating a user-typed label. */
function matchProvider(answer: string): ProviderSpec | undefined {
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return (
    providerById(normalized) ??
    PROVIDERS.find((provider) => provider.label.toLowerCase() === normalized) ??
    PROVIDERS.find((provider) => provider.label.toLowerCase().includes(normalized))
  );
}

async function pickProvider(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  source: LineSource,
  defaultId?: string,
): Promise<ProviderSpec | undefined> {
  const choices: Choice<ProviderSpec>[] = [];
  for (const group of providersByFamily()) {
    for (const provider of group.providers) {
      choices.push({
        label: `${provider.label.padEnd(26)} ${pc.gray(provider.id)}`,
        value: provider,
        group: group.family,
        ...(provider.note !== undefined ? { note: provider.note } : {}),
      });
    }
  }

  const defaultIndex = choices.findIndex((choice) => choice.value.id === defaultId);
  const picked = await choose(input, output, "Choose a provider", choices, 14, Math.max(0, defaultIndex));
  if (picked !== undefined) return picked;

  // Non-interactive fallback: list the ids and read one.
  output.write(`${pc.gray("Providers:")} ${PROVIDERS.map((provider) => provider.id).join(", ")}\n`);
  const answer = await source.ask(defaultId !== undefined ? `Provider id [${defaultId}]: ` : "Provider id: ");
  if (answer !== undefined && answer.trim().length === 0 && defaultId !== undefined) {
    return providerById(defaultId);
  }
  if (answer === undefined) return undefined;
  return matchProvider(answer);
}

/** Asks for the credential, or opens the provider's key page on request. */
async function pickCredential(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  provider: ProviderSpec,
  options: OnboardingOptions,
  source: LineSource,
): Promise<{ key?: string; stored: boolean; cancelled: boolean }> {
  const existing = provider.apiKeyEnv.find((name) => (process.env[name] ?? "").length > 0);
  if (existing !== undefined) {
    output.write(`${pc.green("✓")} Found ${pc.bold(existing)} in the environment; using it.\n`);
    return { stored: false, cancelled: false };
  }

  if (provider.keyless === true) {
    output.write(`${pc.green("✓")} ${provider.label} runs locally and needs no API key.\n`);
    return { stored: false, cancelled: false };
  }

  const preset = options.preset?.apiKey;
  if (preset !== undefined && preset.length > 0) {
    return { key: preset, stored: true, cancelled: false };
  }

  output.write(`\n${pc.bold("API key")}\n`);
  output.write(`${pc.gray("Get one at")} ${pc.cyan(provider.keysUrl)}\n`);
  output.write(
    `${pc.gray("Paste the key, or press")} ${pc.bold("s")} ${pc.gray("to open that page in your browser.")}\n\n`,
  );

  const answer = await source.ask(`${provider.label} API key (or "s" to open the page): `);
  if (answer === undefined) return { stored: false, cancelled: true };
  const trimmed = answer.trim();

  if (trimmed.length > 0 && trimmed.toLowerCase() !== "s") {
    const complaint = looksWrong(trimmed, provider);
    if (complaint !== undefined) {
      output.write(`${pc.yellow("!")} ${complaint}\n`);
      output.write(`${pc.gray("Press Enter to use it anyway, or paste a different key.")}\n`);
      const retry = await askSecret(input, output, "Paste the key: ", source);
      if (retry === undefined) return { stored: false, cancelled: true };
      const cleaned = retry.trim();
      if (cleaned.length === 0) return { key: trimmed, stored: true, cancelled: false };
      if (cleaned.toLowerCase() === "s") return signInOrPaste(input, output, provider, options, source);
      return { key: cleaned, stored: true, cancelled: false };
    }
    return { key: trimmed, stored: true, cancelled: false };
  }

  return signInOrPaste(input, output, provider, options, source);
}

/**
 * "Sign in" path: open the provider's key page in the browser and take the key
 * the user copies from it. Everything the browser cannot do (a real OAuth
 * handshake) is left to the provider's own page, which is where the user is
 * already authenticated.
 */
async function signInOrPaste(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  provider: ProviderSpec,
  options: OnboardingOptions,
  source: LineSource,
): Promise<{ key?: string; stored: boolean; cancelled: boolean }> {
  const open = options.openBrowser ?? defaultOpenBrowser;
  if (provider.keysUrl.length > 0) {
    open(provider.keysUrl);
    output.write(`${pc.gray("Opened")} ${provider.keysUrl}\n`);
  }
  output.write(`${pc.gray("Create or copy a key there, then paste it below.")}\n`);
  output.write(
    isWindows()
      ? `${pc.gray("The page opens in your default browser. To keep the key out of the config file, run")} ` +
          `${pc.bold(`$env:${provider.apiKeyEnv[0]} = "..."`)}${pc.gray(" instead.")}\n`
      : `${pc.gray("The page opens in your default browser. To keep the key out of the config file, run")} ` +
          `${pc.bold(`export ${provider.apiKeyEnv[0]}="..."`)}${pc.gray(" instead.")}\n`,
  );
  const pasted = await askSecret(input, output, "Paste the key: ", source);
  if (pasted === undefined) return { stored: false, cancelled: true };
  const cleaned = pasted.trim();
  if (cleaned.length === 0) return { stored: false, cancelled: true };
  return { key: cleaned, stored: true, cancelled: false };
}

/** A cheap sanity check so an obviously wrong paste is caught while typing. */
function looksWrong(key: string, provider: ProviderSpec): string | undefined {
  if (key.length < 16) return `That looks short for a ${provider.label} key (${key.length} characters).`;
  if (/\s/.test(key)) return "That contains whitespace; keys never do.";
  return undefined;
}

function defaultOpenBrowser(url: string): void {
  void import("node:child_process").then(({ spawn }) => {
    const command =
      process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // The URL is printed above, so a failure here is not fatal.
    }
  });
}

/** Fetches the live model list, falling back to the registry's known models. */
async function pickModel(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  provider: ProviderSpec,
  baseUrl: string,
  apiKey: string | undefined,
  preset: string | undefined,
  source: LineSource,
  defaultModel?: string,
  offline = false,
): Promise<string> {
  // An explicit --model is a decision, not a suggestion: honour it and skip the
  // network probe the picker would otherwise make.
  if (preset !== undefined && preset.trim().length > 0) return preset.trim();

  const probe: ResolvedConfig = {
    provider: provider.id,
    model: provider.defaultModel,
    mode: "ask",
    apiKeyEnv: apiKeyEnvFor(provider.id),
    maxSteps: 30,
    maxTokens: 8192,
    contextWindow: provider.contextWindow,
    bashTimeoutMs: 60000,
    truncateLimit: 8000,
    compactThreshold: 0.75,
    permissions: { allow: [], deny: [] },
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], sessionEnd: [] },
    mcpServers: {},
    planMode: false,
    yolo: false,
    logLevel: "info",
    cwd: process.cwd(),
    allowOutsideWorkspace: false,
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };

  let models: ModelInfo[] = [];
  if (!offline && (provider.knownModels.length === 0 || apiKey !== undefined)) {
    try {
      models = await fetchModels(probe);
    } catch {
      models = [];
    }
  }
  if (models.length === 0) models = knownModelsFor(provider.id);

  if (models.length === 0) {
    const fallback = defaultModel ?? provider.defaultModel;
    const typed = await source.ask(`Model id [${fallback}]: `);
    if (typed === undefined || typed.trim().length === 0) return fallback;
    return typed.trim();
  }

  const defaultIndex = Math.max(
    0,
    models.findIndex((model) => model.id === provider.defaultModel),
  );
  const ordered = [models[defaultIndex], ...models.filter((_, i) => i !== defaultIndex)].filter(
    (model): model is ModelInfo => model !== undefined,
  );

  const choices: Choice<string>[] = ordered.slice(0, 200).map((model) => {
    const tags: string[] = [];
    if (model.reasoning === true) tags.push(pc.magenta("reasoning"));
    if (model.contextWindow !== undefined) tags.push(pc.gray(`${Math.round(model.contextWindow / 1000)}k`));
    const note = tags.length > 0 ? `  ${tags.join(pc.gray(" · "))}` : "";
    return { label: model.id, value: model.id, ...(note.length > 0 ? { note } : {}) };
  });

  const preferred = defaultModel ?? provider.defaultModel;
  const defaultModelIndex = choices.findIndex((choice) => choice.value === preferred);
  const picked = await choose(input, output, "Choose a model", choices, 12, Math.max(0, defaultModelIndex));
  if (picked !== undefined) return picked;

  output.write(`${pc.gray(`${models.length} models available.`)}\n`);
  const answer = await source.ask(`Model id [${provider.defaultModel}]: `);
  if (answer === undefined || answer.trim().length === 0) return provider.defaultModel;
  return answer.trim();
}

async function pickMode(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  preset: PermissionMode | undefined,
  source: LineSource,
): Promise<PermissionMode> {
  if (preset !== undefined) return preset;
  const choices: Choice<PermissionMode>[] = MODE_CYCLE.map((mode) => ({
    label: mode.padEnd(7),
    value: mode,
    note: MODE_NOTES[mode],
  }));
  const picked = await choose(input, output, "Permission mode", choices);
  if (picked !== undefined) return picked;

  const answer = await source.ask(`Permission mode [ask] (${MODE_CYCLE.join("/")}): `);
  if (answer === undefined || answer.trim().length === 0) return "ask";
  const value = answer.trim().toLowerCase() as PermissionMode;
  return MODE_CYCLE.includes(value) ? value : "ask";
}

async function pickEffort(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  preset: Effort | undefined,
): Promise<Effort | undefined> {
  if (preset !== undefined) return preset;
  const options: (Effort | undefined)[] = [undefined, ...EFFORTS];
  const choices: Choice<Effort | undefined>[] = options.map((effort) => ({
    label: effort ?? "off",
    value: effort,
    note: effort === undefined ? "no reasoning hint is sent" : `reasoning_effort=${effort}`,
  }));
  const picked = await choose(input, output, "Reasoning effort", choices);
  if (picked !== undefined) return picked;
  return undefined;
}

/** Writes the answers, creating parent directories and restricting permissions. */
export function writeConfigFile(path: string, shape: ConfigFileShape): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(shape, null, 2)}\n`, "utf8");
  try {
    // 0600: the file can hold an API key. No-op on Windows, where the file
    // inherits the user profile's ACL.
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

export function readConfigFile(path: string): ConfigFileShape {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFileShape;
  } catch {
    return {};
  }
}

/**
 * First-run setup. Picks a provider, collects a credential (pasted or via the
 * provider's sign-in page), selects a model from the live list, and records the
 * permission mode and effort. Everything is written to one file so a later run
 * has nothing left to ask.
 */
export async function runOnboarding(options: OnboardingOptions = {}): Promise<OnboardingResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const configPath = options.outPath ?? userConfigPath();
  const existing = readConfigFile(configPath);
  const preset = options.preset ?? {};
  const source = new LineSource(input, output);

  heading(
    output,
    "Welcome to carls-code",
    "A few questions, then you are ready. Press Ctrl+C to cancel at any point.",
  );

  let provider = preset.provider !== undefined ? providerById(preset.provider) : undefined;
  if (provider === undefined && preset.baseUrl !== undefined) provider = providerById("compatible");
  if (provider === undefined) provider = await pickProvider(input, output, source, options.defaultProvider);
  if (provider === undefined) {
    return { configPath, provider: "", model: "", apiKeyEnv: "", storedKey: false, cancelled: true };
  }
  output.write(`${pc.green("✓")} ${provider.label}${provider.note !== undefined ? pc.gray(` — ${provider.note}`) : ""}\n`);

  let baseUrl = preset.baseUrl ?? provider.baseUrl;
  if (provider.id === "compatible" && preset.baseUrl === undefined) {
    const typed = await source.ask(`Base URL [${provider.baseUrl}]: `);
    if (typed !== undefined && typed.trim().length > 0) baseUrl = typed.trim();
  }
  if (provider.id === "azure-openai" && baseUrl.includes("YOUR-RESOURCE") && preset.baseUrl === undefined) {
    const typed = await source.ask("Azure resource name: ");
    if (typed !== undefined && typed.trim().length > 0) {
      baseUrl = baseUrl.replace("YOUR-RESOURCE", typed.trim());
    }
  }

  const credential = await pickCredential(input, output, provider, options, source);
  if (credential.cancelled) {
    return { configPath, provider: provider.id, model: "", apiKeyEnv: apiKeyEnvFor(provider.id), storedKey: false, cancelled: true };
  }

  const model = await pickModel(
    input,
    output,
    provider,
    baseUrl,
    credential.key,
    preset.model,
    source,
    options.defaultModel,
    options.offline === true,
  );
  output.write(`${pc.green("✓")} Model ${pc.bold(model)}\n`);

  const mode = await pickMode(input, output, preset.mode, source);
  const effort = await pickEffort(input, output, preset.effort);

  const verify = await verifyCredential(
    provider,
    baseUrl,
    credential.key ?? process.env[apiKeyEnvFor(provider.id)],
    options.offline === true,
  );
  if (verify.ok) {
    output.write(`${verify.line}\n`);
  } else {
    output.write(`\n${pc.yellow("!")} ${verify.line}\n`);
    output.write(`${pc.gray("Common causes: a typo in the key, the wrong provider, or a network/proxy that blocks the host.")}\n`);
    const retry = await source.ask("Try a different key now? [y/N]: ");
    if (retry !== undefined && retry.trim().toLowerCase().startsWith("y")) {
      const replacement = await askSecret(input, output, "Paste the key: ", source);
      if (replacement !== undefined && replacement.trim().length > 0) {
        credential.key = replacement.trim();
        credential.stored = true;
        const second = await verifyCredential(provider, baseUrl, credential.key, options.offline === true);
        output.write(`${second.line}\n`);
      }
    }
    output.write(
      `${pc.gray("Saving anyway; check it later with")} ${pc.bold("carls --doctor")}${pc.gray(". Keys live at")} ${pc.cyan(provider.keysUrl)}\n`,
    );
  }

  const shape: ConfigFileShape = {
    ...existing,
    provider: provider.id,
    baseUrl,
    model,
    mode,
    apiKeyEnv: apiKeyEnvFor(provider.id),
    onboarded: true,
  };
  if (effort !== undefined) shape.effort = effort;
  else delete shape.effort;
  if (credential.key !== undefined) shape.apiKey = credential.key;

  writeConfigFile(configPath, shape);

  output.write("\n");
  output.write(`${pc.green("✓")} Wrote ${pc.bold(configPath)}\n`);
  if (credential.stored) {
    output.write(
      `${pc.gray("  The key is stored in that file (mode 600). Set")} ${pc.bold(apiKeyEnvFor(provider.id))} ${pc.gray("to keep it out of the file.")}\n`,
    );
  }
  output.write(`${pc.gray("  Start the REPL with")} ${pc.bold("carls")}${pc.gray(", or check everything with")} ${pc.bold("/doctor")}${pc.gray(".")}\n\n`);

  return {
    configPath,
    provider: provider.id,
    model,
    apiKeyEnv: apiKeyEnvFor(provider.id),
    storedKey: credential.stored,
    cancelled: false,
  };
}

/** One live request, so a wrong key is caught during setup rather than later. */
async function verifyCredential(
  provider: ProviderSpec,
  baseUrl: string,
  apiKey: string | undefined,
  offline = false,
): Promise<{ ok: boolean; line: string }> {
  if (offline) return { ok: true, line: "Skipped the live check (offline setup)." };
  const probe: ResolvedConfig = {
    provider: provider.id,
    model: provider.defaultModel,
    mode: "ask",
    apiKeyEnv: apiKeyEnvFor(provider.id),
    maxSteps: 30,
    maxTokens: 8192,
    contextWindow: provider.contextWindow,
    bashTimeoutMs: 60000,
    truncateLimit: 8000,
    compactThreshold: 0.75,
    permissions: { allow: [], deny: [] },
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], sessionEnd: [] },
    mcpServers: {},
    planMode: false,
    yolo: false,
    logLevel: "info",
    cwd: process.cwd(),
    allowOutsideWorkspace: false,
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
  try {
    const models = await fetchModels(probe);
    return { ok: true, line: `${pc.green("✓")} Reached ${baseUrl} ${pc.gray(`(${models.length} models)`)}` };
  } catch (error) {
    return {
      ok: false,
      line: `Could not reach ${baseUrl} yet: ${pc.gray(redact((error as Error).message).slice(0, 120))}`,
    };
  }
}

/** True when no provider has usable credentials, so setup should run. */
export function needsOnboarding(config: ResolvedConfig): boolean {
  const spec = providerById(config.provider);
  if (spec?.keyless === true) return false;
  if (config.apiKey !== undefined && config.apiKey.length > 0) return false;
  const names = spec?.apiKeyEnv ?? [config.apiKeyEnv];
  return !names.some((name) => (process.env[name] ?? "").length > 0);
}

export function defaultModelForProvider(provider: string): string {
  return defaultModelFor(provider);
}

/** Path of the user config used by onboarding, exposed for messages. */
export function onboardingConfigPath(): string {
  return userConfigPath();
}
