import { providerById } from "../providers/registry.js";

/**
 * Discovery helpers for locally hosted backends.
 *
 * The bundled local providers each ship a fixed port, but people move them:
 * vLLM on 8001, llama.cpp on 8081, Ollama bound to a non-default host. Rather
 * than making the user guess, the setup wizard and /doctor probe the usual ports
 * and report what answered.
 */

export interface LocalBackend {
  /** Registry provider id that matches what answered. */
  provider: string;
  label: string;
  /** Base URL that responded, without a trailing slash. */
  baseUrl: string;
  /** Model ids the endpoint reported. */
  models: string[];
}

interface ProbeTarget {
  provider: string;
  /** Candidate base URLs, tried in order. */
  urls: string[];
}

/**
 * Common localhost endpoints. Ollama keeps its native API at the root and the
 * OpenAI shim under /v1; both are probed because either may be the only one
 * enabled.
 */
const PROBE_TARGETS: ProbeTarget[] = [
  { provider: "ollama", urls: ["http://localhost:11434", "http://127.0.0.1:11434"] },
  { provider: "lmstudio", urls: ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1"] },
  { provider: "vllm", urls: ["http://localhost:8000/v1", "http://127.0.0.1:8000/v1"] },
  { provider: "llamacpp", urls: ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1"] },
];

const PROBE_TIMEOUT_MS = 1200;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads model ids from either an OpenAI `/models` list or a native `/api/tags`. */
function extractModelIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const object = payload as { data?: unknown; models?: unknown };
  const rows = Array.isArray(object.data)
    ? object.data
    : Array.isArray(object.models)
      ? object.models
      : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const entry = row as { id?: unknown; name?: unknown; model?: unknown };
    const id =
      typeof entry.id === "string"
        ? entry.id
        : typeof entry.name === "string"
          ? entry.name
          : typeof entry.model === "string"
            ? entry.model
            : undefined;
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Probes the well-known local ports and returns every backend that answered.
 * A connection refused is the normal case, not an error, so failures are
 * swallowed and simply produce no result.
 */
export async function discoverLocalBackends(): Promise<LocalBackend[]> {
  const found: LocalBackend[] = [];
  for (const target of PROBE_TARGETS) {
    const spec = providerById(target.provider);
    if (spec === undefined) continue;
    const isOllama = target.provider === "ollama";
    const paths = isOllama ? ["/api/tags", "/v1/models"] : ["/models"];
    let reported = false;
    for (const base of target.urls) {
      if (reported) break;
      for (const path of paths) {
        try {
          const res = await fetchWithTimeout(`${base}${path}`);
          if (!res.ok) continue;
          const models = extractModelIds(await res.json());
          found.push({
            provider: target.provider,
            label: spec.label,
            baseUrl: base,
            models,
          });
          reported = true;
          break;
        } catch {
          // Nothing listening, or not the endpoint we guessed. Keep probing.
        }
      }
    }
  }
  return found;
}

/**
 * Best-effort context window for a model served by a local OpenAI-compatible
 * endpoint. vLLM exposes `max_model_len` per model; llama.cpp reports the
 * loaded context as `n_ctx`. Ollama has its own reader in the catalog.
 */
export async function localModelContext(
  baseUrl: string,
  model: string,
): Promise<number | undefined> {
  const root = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetchWithTimeout(`${root}/models`);
    if (!res.ok) return undefined;
    const payload = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const entry = row as { id?: unknown; max_model_len?: unknown; n_ctx?: unknown };
      const id = typeof entry.id === "string" ? entry.id : undefined;
      if (id !== undefined && id !== model) continue;
      const candidates = [entry.max_model_len, entry.n_ctx];
      for (const value of candidates) {
        if (typeof value === "number" && value > 0) return value;
      }
    }
  } catch {
    // The endpoint may not expose /models at all; the config default stands.
  }
  return undefined;
}
