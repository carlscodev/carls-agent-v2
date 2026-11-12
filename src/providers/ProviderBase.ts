import type { ContentBlock, Message, Provider } from "../types/llm.js";
import type { ResolvedConfig } from "../config/Config.js";
import { providerById, type ProviderSpec } from "./registry.js";
import { AnthropicProvider } from "./AnthropicProvider.js";
import { OpenAICompatProvider } from "./OpenAICompatProvider.js";
import { OllamaProvider, type OllamaOptions } from "./OllamaProvider.js";
import { FatalError } from "./retry.js";

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Resolves the API key from the environment first, then the config file.
 * Returns undefined when neither source provides one.
 */
export function resolveApiKey(config: ResolvedConfig): string | undefined {
  const spec = providerById(config.provider);
  // Every alias the provider accepts is checked, so an existing
  // GOOGLE_API_KEY or NVIDIA_NIM_API_KEY works without renaming.
  const names = spec !== undefined ? [...spec.apiKeyEnv] : [];
  if (!names.includes(config.apiKeyEnv)) names.push(config.apiKeyEnv);
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  if (config.apiKey !== undefined && config.apiKey.length > 0) return config.apiKey;
  return undefined;
}

export function readApiKey(config: ResolvedConfig): string {
  const value = resolveApiKey(config);
  if (value === undefined) {
    throw new FatalError(
      `Missing API key: set ${config.apiKeyEnv} in your environment or "apiKey" in .carlsrc.json.`,
    );
  }
  return value;
}

export function createProvider(
  config: ResolvedConfig,
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
): Provider {
  const spec = providerById(config.provider);
  const protocol = spec?.protocol ?? "openai";
  // A keyless local backend still needs a placeholder: most servers ignore the
  // header, but the client must send something well-formed.
  const apiKey = resolveApiKey(config) ?? (spec?.keyless === true ? "carls-local" : readApiKey(config));

  if (protocol === "anthropic") return new AnthropicProvider(apiKey, config.baseUrl);
  if (protocol === "ollama") {
    const options: OllamaOptions = {};
    // Forward the configured window so the server allocates enough context for
    // the whole prompt instead of falling back to its 4096-token default.
    if (config.contextWindow > 0) options.numCtx = config.contextWindow;
    if (onRetry !== undefined) options.onRetry = onRetry;
    return new OllamaProvider(config.baseUrl, options);
  }
  return new OpenAICompatProvider(apiKey, config.baseUrl, onRetry, {
    supportsReasoningEffort: supportsReasoningEffort(spec),
  });
}

/**
 * Whether a backend understands `reasoning_effort`. Sending it to a server that
 * does not recognise the field is rejected by strict implementations and
 * silently ignored by others, so it is opt-in per provider.
 */
export function supportsReasoningEffort(spec: ProviderSpec | undefined): boolean {
  if (spec === undefined) return false;
  // The OpenAI-compatible shim in Ollama and the local servers ignore the field.
  if (spec.protocol !== "openai") return false;
  return spec.local !== true;
}

/** Merges consecutive same-role messages, required by strict chat APIs. */
export function coalesceMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content = [...last.content, ...message.content];
    } else {
      out.push({ role: message.role, content: [...message.content] });
    }
  }
  return out;
}
