/**
 * Provider registry.
 *
 * Every supported backend is described here once: base URL, credential
 * environment variable, a sensible default model, a few known models for
 * offline use, and the page where a user creates a key. Adding a provider is a
 * data change, not a code change, and the onboarding wizard, the model
 * selector, `/doctor` and the installer all read from this table.
 *
 * The wire protocol is one of:
 *  - "openai":    POST {baseUrl}/chat/completions, GET {baseUrl}/models
 *  - "anthropic": the Anthropic Messages API
 *  - "ollama":    the native Ollama API (/api/chat, /api/tags, /api/show),
 *                 which exposes num_ctx and tool calling the /v1 shim hides
 */

export type WireProtocol = "openai" | "anthropic" | "ollama";

export type ProviderFamily =
  | "Frontier"
  | "Aggregator"
  | "Fast inference"
  | "Open weights"
  | "Enterprise"
  | "Self-hosted";

export interface ProviderSpec {
  id: string;
  label: string;
  family: ProviderFamily;
  protocol: WireProtocol;
  /** API root, without a trailing slash. */
  baseUrl: string;
  /** Environment variables checked in order; the first wins. */
  apiKeyEnv: string[];
  /** Model used when the config does not name one. */
  defaultModel: string;
  /** A handful of real model ids, used before the endpoint is reachable. */
  knownModels: string[];
  /** Where the user creates or copies an API key. */
  keysUrl: string;
  /** Context window assumed for models from this provider, in tokens. */
  contextWindow: number;
  /** Substrings that mark a model id as accepting a reasoning-effort hint. */
  reasoningHints?: string[];
  /** True when the provider serves models without a key. */
  keyless?: boolean;
  /** True for providers that usually run on localhost. */
  local?: boolean;
  /** One line shown in the onboarding wizard. */
  note?: string;
}

const REASONING_DEFAULT = [
  "o1",
  "o3",
  "o4",
  "gpt-5",
  "gpt-6",
  "reason",
  "thinking",
  "qwq",
  "deepseek-r",
  "glm-z",
  "kimi-thinking",
  "magistral",
];

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    family: "Frontier",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-20250514",
    knownModels: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022",
    ],
    keysUrl: "https://console.anthropic.com/settings/keys",
    contextWindow: 200000,
    reasoningHints: ["claude-3-7", "thinking", "sonnet-4", "opus-4"],
  },
  {
    id: "openai",
    label: "OpenAI",
    family: "Frontier",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    knownModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini", "o3"],
    keysUrl: "https://platform.openai.com/api-keys",
    contextWindow: 128000,
    reasoningHints: REASONING_DEFAULT,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    family: "Aggregator",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    defaultModel: "anthropic/claude-sonnet-4",
    knownModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat-v3.1",
      "qwen/qwen3-coder",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    keysUrl: "https://openrouter.ai/keys",
    contextWindow: 200000,
    reasoningHints: REASONING_DEFAULT,
    note: "One key for hundreds of models, with automatic fallback between them.",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    family: "Enterprise",
    protocol: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
    defaultModel: "qwen/qwen3-coder-480b-a35b-instruct",
    knownModels: [
      "qwen/qwen3-coder-480b-a35b-instruct",
      "deepseek-ai/deepseek-v3.1",
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "mistralai/mistral-large-2-instruct",
    ],
    keysUrl: "https://build.nvidia.com/settings/api-keys",
    contextWindow: 128000,
    reasoningHints: [...REASONING_DEFAULT, "nemotron", "qwen3"],
    note: "NVIDIA-hosted NIM endpoints for open models, with a generous free tier.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-chat",
    knownModels: ["deepseek-chat", "deepseek-reasoner"],
    keysUrl: "https://platform.deepseek.com/api_keys",
    contextWindow: 128000,
    reasoningHints: [...REASONING_DEFAULT, "deepseek-reasoner"],
  },
  {
    id: "google",
    label: "Google Gemini",
    family: "Frontier",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-2.5-pro",
    knownModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    keysUrl: "https://aistudio.google.com/apikey",
    contextWindow: 1000000,
    reasoningHints: [...REASONING_DEFAULT, "gemini-2.5", "gemma-3"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    family: "Frontier",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: ["XAI_API_KEY"],
    defaultModel: "grok-4",
    knownModels: ["grok-4", "grok-3", "grok-3-mini", "grok-code-fast-1"],
    keysUrl: "https://console.x.ai",
    contextWindow: 256000,
    reasoningHints: [...REASONING_DEFAULT, "grok-3-mini", "grok-4"],
  },
  {
    id: "groq",
    label: "Groq",
    family: "Fast inference",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    defaultModel: "llama-3.3-70b-versatile",
    knownModels: [
      "llama-3.3-70b-versatile",
      "qwen/qwen3-32b",
      "moonshotai/kimi-k2-instruct",
      "deepseek-r1-distill-llama-70b",
    ],
    keysUrl: "https://console.groq.com/keys",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3", "kimi-k2"],
    note: "Very low latency, good for tight gather-act-verify loops.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    family: "Fast inference",
    protocol: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: ["CEREBRAS_API_KEY"],
    defaultModel: "qwen-3-coder-480b",
    knownModels: ["qwen-3-coder-480b", "llama-3.3-70b", "qwen-3-235b-a22b-instruct"],
    keysUrl: "https://cloud.cerebras.ai",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen-3"],
  },
  {
    id: "mistral",
    label: "Mistral",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    defaultModel: "mistral-large-latest",
    knownModels: ["mistral-large-latest", "codestral-latest", "magistral-medium-latest", "devstral-medium-latest"],
    keysUrl: "https://console.mistral.ai/api-keys",
    contextWindow: 128000,
    reasoningHints: [...REASONING_DEFAULT, "magistral", "devstral"],
  },
  {
    id: "together",
    label: "Together AI",
    family: "Aggregator",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: ["TOGETHER_API_KEY"],
    defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    knownModels: [
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "moonshotai/Kimi-K2-Instruct",
    ],
    keysUrl: "https://api.together.xyz/settings/api-keys",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3", "kimi-k2"],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    family: "Fast inference",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: ["FIREWORKS_API_KEY"],
    defaultModel: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
    knownModels: [
      "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
    ],
    keysUrl: "https://fireworks.ai/account/api-keys",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: ["DEEPINFRA_API_KEY"],
    defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    knownModels: [
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "deepseek-ai/DeepSeek-V3.1",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
    keysUrl: "https://deepinfra.com/dash/api_keys",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: ["HYPERBOLIC_API_KEY"],
    defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    knownModels: [
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
    keysUrl: "https://app.hyperbolic.xyz/settings",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "novita",
    label: "Novita AI",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.novita.ai/v3/openai",
    apiKeyEnv: ["NOVITA_API_KEY"],
    defaultModel: "qwen/qwen3-coder-480b-a35b-instruct",
    knownModels: ["qwen/qwen3-coder-480b-a35b-instruct", "deepseek/deepseek-v3.1", "meta-llama/llama-3.3-70b-instruct"],
    keysUrl: "https://novita.ai/settings/key-management",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.studio.nebius.com/v1",
    apiKeyEnv: ["NEBIUS_API_KEY"],
    defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    knownModels: ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "deepseek-ai/DeepSeek-V3", "meta-llama/Llama-3.3-70B-Instruct"],
    keysUrl: "https://studio.nebius.com/settings/api-keys",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "sambanova",
    label: "SambaNova",
    family: "Fast inference",
    protocol: "openai",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: ["SAMBANOVA_API_KEY"],
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    knownModels: ["Meta-Llama-3.3-70B-Instruct", "DeepSeek-V3-0324", "Qwen3-32B"],
    keysUrl: "https://cloud.sambanova.ai/apis",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "lambda",
    label: "Lambda",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.lambdalabs.com/v1",
    apiKeyEnv: ["LAMBDA_API_KEY"],
    defaultModel: "qwen3-coder-480b-a35b-instruct",
    knownModels: ["qwen3-coder-480b-a35b-instruct", "deepseek-v3-0324", "llama-3.3-70b-instruct"],
    keysUrl: "https://cloud.lambdalabs.com/api-keys",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    family: "Aggregator",
    protocol: "openai",
    baseUrl: "https://api.perplexity.ai",
    apiKeyEnv: ["PERPLEXITY_API_KEY"],
    defaultModel: "sonar-pro",
    knownModels: ["sonar-pro", "sonar", "sonar-reasoning-pro"],
    keysUrl: "https://www.perplexity.ai/settings/api",
    contextWindow: 128000,
    reasoningHints: [...REASONING_DEFAULT, "sonar-reasoning"],
    note: "Answers grounded in live web search.",
  },
  {
    id: "cohere",
    label: "Cohere",
    family: "Enterprise",
    protocol: "openai",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyEnv: ["COHERE_API_KEY"],
    defaultModel: "command-a-03-2025",
    knownModels: ["command-a-03-2025", "command-r-plus-08-2024", "command-r7b-12-2024"],
    keysUrl: "https://dashboard.cohere.com/api-keys",
    contextWindow: 256000,
    reasoningHints: [...REASONING_DEFAULT, "reasoning"],
  },
  {
    id: "ai21",
    label: "AI21 Labs",
    family: "Enterprise",
    protocol: "openai",
    baseUrl: "https://api.ai21.com/studio/v1",
    apiKeyEnv: ["AI21_API_KEY"],
    defaultModel: "jamba-large-1.7",
    knownModels: ["jamba-large-1.7", "jamba-mini-1.7"],
    keysUrl: "https://studio.ai21.com/account/api-key",
    contextWindow: 256000,
    reasoningHints: REASONING_DEFAULT,
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    defaultModel: "kimi-k2-0905-preview",
    knownModels: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-128k"],
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    contextWindow: 256000,
    reasoningHints: [...REASONING_DEFAULT, "kimi-k2", "kimi-thinking"],
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    defaultModel: "glm-4.6",
    knownModels: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    contextWindow: 200000,
    reasoningHints: [...REASONING_DEFAULT, "glm-4.5", "glm-4.6", "glm-z"],
  },
  {
    id: "dashscope",
    label: "Alibaba DashScope (Qwen)",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    defaultModel: "qwen3-coder-plus",
    knownModels: ["qwen3-coder-plus", "qwen3-max", "qwen-plus", "qwen3-235b-a22b"],
    keysUrl: "https://bailian.console.alibabacloud.com",
    contextWindow: 131072,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    family: "Open weights",
    protocol: "openai",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyEnv: ["MINIMAX_API_KEY"],
    defaultModel: "MiniMax-M2",
    knownModels: ["MiniMax-M2", "MiniMax-Text-01", "abab6.5s-chat"],
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    contextWindow: 200000,
    reasoningHints: [...REASONING_DEFAULT, "m2"],
  },
  {
    id: "aleph-alpha",
    label: "Aleph Alpha",
    family: "Enterprise",
    protocol: "openai",
    baseUrl: "https://api.aleph-alpha.com/v1",
    apiKeyEnv: ["ALEPH_ALPHA_API_KEY"],
    defaultModel: "llama-3.1-70b-instruct",
    knownModels: ["llama-3.1-70b-instruct", "llama-3.1-8b-instruct"],
    keysUrl: "https://app.aleph-alpha.com/profile",
    contextWindow: 128000,
    reasoningHints: REASONING_DEFAULT,
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    family: "Enterprise",
    protocol: "openai",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    apiKeyEnv: ["AZURE_OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    knownModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    keysUrl: "https://portal.azure.com",
    contextWindow: 128000,
    reasoningHints: REASONING_DEFAULT,
    note: "Replace YOUR-RESOURCE in the base URL with your deployment's resource name.",
  },
  {
    id: "github-models",
    label: "GitHub Models",
    family: "Aggregator",
    protocol: "openai",
    baseUrl: "https://models.github.ai/inference",
    apiKeyEnv: ["GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"],
    defaultModel: "openai/gpt-4o",
    knownModels: ["openai/gpt-4o", "openai/gpt-4o-mini", "meta/Llama-3.3-70B-Instruct", "deepseek/DeepSeek-V3-0324"],
    keysUrl: "https://github.com/settings/tokens",
    contextWindow: 128000,
    reasoningHints: REASONING_DEFAULT,
    note: "Uses a GitHub personal access token; free within rate limits.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    family: "Self-hosted",
    // Native /api/chat: sets num_ctx and reports the real context length.
    protocol: "ollama",
    baseUrl: "http://localhost:11434",
    apiKeyEnv: ["OLLAMA_API_KEY"],
    defaultModel: "qwen3-coder:30b",
    knownModels: ["qwen3-coder:30b", "qwen3:32b", "llama3.3:70b", "deepseek-coder-v2:16b"],
    keysUrl: "https://ollama.com/download",
    contextWindow: 32768,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
    keyless: true,
    local: true,
    note: "Runs on your machine; no API key is required.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    family: "Self-hosted",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: ["LMSTUDIO_API_KEY"],
    defaultModel: "local-model",
    knownModels: ["local-model"],
    keysUrl: "https://lmstudio.ai",
    contextWindow: 32768,
    reasoningHints: REASONING_DEFAULT,
    keyless: true,
    local: true,
    note: "Serves whatever model you loaded in LM Studio.",
  },
  {
    id: "vllm",
    label: "vLLM (self-hosted)",
    family: "Self-hosted",
    protocol: "openai",
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: ["VLLM_API_KEY"],
    defaultModel: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    knownModels: ["Qwen/Qwen3-Coder-30B-A3B-Instruct"],
    keysUrl: "https://docs.vllm.ai",
    contextWindow: 32768,
    reasoningHints: [...REASONING_DEFAULT, "qwen3"],
    keyless: true,
    local: true,
    note: "Point the base URL at your vLLM server.",
  },
  {
    id: "llamacpp",
    label: "llama.cpp server (local)",
    family: "Self-hosted",
    protocol: "openai",
    baseUrl: "http://localhost:8080/v1",
    apiKeyEnv: ["LLAMACPP_API_KEY"],
    defaultModel: "local-model",
    knownModels: ["local-model"],
    keysUrl: "https://github.com/ggml-org/llama.cpp",
    contextWindow: 32768,
    reasoningHints: REASONING_DEFAULT,
    keyless: true,
    local: true,
    note: "llama-server exposes an OpenAI-compatible endpoint.",
  },
  {
    id: "compatible",
    label: "Other OpenAI-compatible endpoint",
    family: "Self-hosted",
    protocol: "openai",
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    knownModels: [],
    keysUrl: "https://platform.openai.com/docs/api-reference",
    contextWindow: 128000,
    reasoningHints: REASONING_DEFAULT,
    note: "Any gateway that speaks /chat/completions. Set the base URL yourself.",
  },
];

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function providerById(id: string): ProviderSpec | undefined {
  return BY_ID.get(id.toLowerCase());
}

export function providerIds(): string[] {
  return PROVIDERS.map((provider) => provider.id);
}

/** Providers that need no key, so onboarding can skip the credential step. */
export function keylessProviders(): ProviderSpec[] {
  return PROVIDERS.filter((provider) => provider.keyless === true);
}

/** Groups providers by family, preserving the registry order inside a family. */
export function providersByFamily(): { family: ProviderFamily; providers: ProviderSpec[] }[] {
  const order: ProviderFamily[] = [
    "Frontier",
    "Aggregator",
    "Fast inference",
    "Open weights",
    "Enterprise",
    "Self-hosted",
  ];
  return order
    .map((family) => ({ family, providers: PROVIDERS.filter((provider) => provider.family === family) }))
    .filter((group) => group.providers.length > 0);
}

/** Reasoning hints for a provider, falling back to the shared defaults. */
export function reasoningHintsFor(spec: ProviderSpec | undefined): string[] {
  return spec?.reasoningHints ?? REASONING_DEFAULT;
}

export const PROVIDER_COUNT = PROVIDERS.length;
