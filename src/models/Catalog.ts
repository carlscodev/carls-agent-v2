import { resolveApiKey } from "../providers/ProviderBase.js";
import { ollamaShow, ollamaTags } from "../providers/OllamaProvider.js";
import { providerById, reasoningHintsFor } from "../providers/registry.js";
import type { ResolvedConfig } from "../config/Config.js";

export interface ModelInfo {
  id: string;
  /** True when the model accepts a reasoning effort hint. */
  reasoning?: boolean;
  /** Free of charge on this endpoint (heuristic, provider-specific). */
  free?: boolean;
  contextWindow?: number;
  /** The model advertises tool calling (reported by native Ollama). */
  tools?: boolean;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  details?: unknown;
}

function inferReasoning(id: string, provider: string): boolean {
  const lower = id.toLowerCase();
  return reasoningHintsFor(providerById(provider)).some((hint) => lower.includes(hint));
}

function normalize(raw: RawModel, provider: string): ModelInfo | undefined {
  const id = typeof raw.id === "string" && raw.id.length > 0
    ? raw.id
    : typeof raw.name === "string" && raw.name.length > 0
      ? raw.name
      : undefined;
  if (id === undefined) return undefined;
  const info: ModelInfo = { id };
  const reasoning = raw.reasoning;
  if (typeof reasoning === "boolean") {
    info.reasoning = reasoning;
  } else {
    info.reasoning = inferReasoning(id, provider);
  }
  const context = raw.context_length ?? raw.context_window;
  if (typeof context === "number" && context > 0) info.contextWindow = context;
  if (id.startsWith("free/") || id.endsWith(":free")) info.free = true;
  return info;
}

export class ModelCatalogError extends Error {}

/**
 * The models a provider is known to serve, used before the endpoint is
 * reachable: during onboarding, offline, or when a key is not accepted yet.
 */
export function knownModelsFor(provider: string, contextWindow?: number): ModelInfo[] {
  const spec = providerById(provider);
  if (spec === undefined) return [];
  return spec.knownModels.map((id) => {
    const info: ModelInfo = { id, reasoning: inferReasoning(id, provider) };
    const window = contextWindow ?? spec.contextWindow;
    if (window > 0) info.contextWindow = window;
    return info;
  });
}

/**
 * Lists models from a native Ollama daemon.
 *
 * The OpenAI shim at /v1/models answers with ids only, which leaves the context
 * window unknown; /api/tags plus /api/show report the real per-model window and
 * whether the model can call tools.
 */
async function fetchOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const tags = await ollamaTags(baseUrl, signal);
  const models = await Promise.all(
    tags.map(async (tag): Promise<ModelInfo> => {
      const info: ModelInfo = { id: tag.name, reasoning: inferReasoning(tag.name, "ollama") };
      try {
        const detail = await ollamaShow(baseUrl, tag.name, signal);
        if (detail.contextLength !== undefined) info.contextWindow = detail.contextLength;
        if (detail.tools === true) info.tools = true;
      } catch {
        // A model can be listed but not inspectable (still downloading); the
        // listing is more useful than failing the whole call.
      }
      return info;
    }),
  );
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/**
 * Fetches the model list from an OpenAI-compatible `/models` endpoint. Falls
 * back to `data[].id`-only payloads, which several gateways return.
 */
export async function fetchModels(
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const spec = providerById(config.provider);
  const baseUrl = (config.baseUrl ?? "").replace(/\/$/, "");
  if (baseUrl.length === 0) {
    throw new ModelCatalogError(
      `Provider "${config.provider}" has no base URL; set one with carls --setup.`,
    );
  }
  if (spec?.protocol === "ollama") return fetchOllamaModels(baseUrl, signal);

  // A keyless local backend still answers /models; it just ignores the header.
  const apiKey = resolveApiKey(config) ?? (spec?.keyless === true ? "carls-local" : undefined);
  if (apiKey === undefined) {
    throw new ModelCatalogError(
      `No API key configured for ${spec?.label ?? config.provider}, cannot list models. Run carls --setup.`,
    );
  }

  const res = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ModelCatalogError(`HTTP ${res.status} from ${baseUrl}/models: ${text.slice(0, 200)}`);
  }

  const payload = (await res.json()) as { data?: RawModel[] } | RawModel[];
  const rows = Array.isArray(payload) ? payload : (payload.data ?? []);
  const models = rows.map((row) => normalize(row, config.provider)).filter((m): m is ModelInfo => m !== undefined);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}
