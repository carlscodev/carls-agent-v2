import type {
  CompletionArgs,
  ContentBlock,
  LLMResponse,
  Message,
  Provider,
  StopReason,
} from "../types/llm.js";
import { withRetry, httpError } from "./retry.js";

/**
 * Native Ollama provider.
 *
 * The OpenAI-compatible shim at /v1 accepts the same messages, but it drops the
 * knobs that matter on a local model: the context window is fixed by the server
 * (num_ctx) and there is no way to pass it through, and reasoning_effort is not
 * a concept. Talking to /api/chat directly lets us set num_ctx and num_predict,
 * which is the difference between a usable session and one that silently
 * truncates the prompt at the model's 4096-token default.
 */

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  /** Ollama marks tool results with the originating tool name. */
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function toOllamaMessages(system: string, messages: Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      const entry: OllamaMessage = { role: "assistant", content: text };
      const calls: OllamaToolCall[] = message.content
        .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
        .map((block) => ({
          function: { name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> },
        }));
      if (calls.length > 0) entry.tool_calls = calls;
      out.push(entry);
      continue;
    }
    const textBlocks = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
    );
    if (textBlocks.length > 0) {
      out.push({ role: "user", content: textBlocks.map((block) => block.text).join("") });
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        // Ollama expects tool results as a user turn; the tool name is optional
        // metadata the server uses to attribute the output.
        out.push({ role: "tool", content: block.content });
      }
    }
  }
  return out;
}

/** Ollama reports "stop", "length" or nothing at all. */
function mapStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

export interface OllamaOptions {
  /** Context window sent as num_ctx. Undefined lets the server decide. */
  numCtx?: number;
  /** Overrides the model default temperature, useful for deterministic edits. */
  temperature?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly options: OllamaOptions;

  constructor(baseUrl?: string, options: OllamaOptions = {}) {
    // The native API lives at the root, not under /v1, so a base URL copied
    // from the OpenAI-compatible docs is normalised here.
    this.baseUrl = (baseUrl ?? "http://localhost:11434").replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.options = options;
  }

  async complete(args: CompletionArgs): Promise<LLMResponse> {
    const options: Record<string, unknown> = { num_predict: args.maxTokens };
    if (this.options.numCtx !== undefined) options.num_ctx = this.options.numCtx;
    if (this.options.temperature !== undefined) options.temperature = this.options.temperature;

    const body: Record<string, unknown> = {
      model: args.model,
      stream: false,
      messages: toOllamaMessages(args.system, args.messages),
      options,
    };
    if (args.tools.length > 0) {
      body.tools = args.tools.map((schema) => ({
        type: "function",
        function: {
          name: schema.name,
          description: schema.description,
          parameters: schema.input_schema,
        },
      }));
    }

    const response = await withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(args.signal !== undefined ? { signal: args.signal } : {}),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw httpError(res.status, `Ollama HTTP ${res.status}: ${text.slice(0, 500)}`);
        }
        const parsed = (await res.json()) as OllamaChatResponse;
        // Ollama reports failures inside a 200 body, so surface them as errors.
        if (typeof parsed.error === "string" && parsed.error.length > 0) {
          throw httpError(400, `Ollama: ${parsed.error}`);
        }
        return parsed;
      },
      this.options.onRetry !== undefined ? { onRetry: this.options.onRetry } : {},
    );

    const content: ContentBlock[] = [];
    const text = response.message?.content ?? "";
    if (text.length > 0) {
      content.push({ type: "text", text });
      args.onText?.(text);
    }
    const calls = response.message?.tool_calls ?? [];
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      if (call === undefined) continue;
      const raw = call.function.arguments;
      const input = typeof raw === "string" ? safeParse(raw) : raw;
      // Ollama does not assign tool-call ids, but the loop needs one to pair the
      // result with the call, so a deterministic id is derived from the index.
      content.push({ type: "tool_use", id: `ollama-${index}-${call.function.name}`, name: call.function.name, input });
    }

    return {
      content,
      stopReason: mapStopReason(response.done_reason, calls.length > 0),
      usage: {
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
      },
    };
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

export interface OllamaModelDetails {
  name: string;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  sizeBytes?: number;
}

interface OllamaTagsResponse {
  models?: {
    name?: string;
    model?: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
  }[];
}

/** Lists the models the local Ollama daemon has pulled. */
export async function ollamaTags(baseUrl: string, signal?: AbortSignal): Promise<OllamaModelDetails[]> {
  const root = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const res = await fetch(`${root}/api/tags`, { ...(signal !== undefined ? { signal } : {}) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned HTTP ${res.status}`);
  const payload = (await res.json()) as OllamaTagsResponse;
  const out: OllamaModelDetails[] = [];
  for (const row of payload.models ?? []) {
    const name = row.name ?? row.model;
    if (name === undefined) continue;
    const details: OllamaModelDetails = { name };
    if (row.size !== undefined) details.sizeBytes = row.size;
    if (row.details?.parameter_size !== undefined) details.parameterSize = row.details.parameter_size;
    if (row.details?.quantization_level !== undefined) details.quantization = row.details.quantization_level;
    if (row.details?.family !== undefined) details.family = row.details.family;
    out.push(details);
  }
  return out;
}

export interface OllamaModelInfo {
  contextLength?: number;
  /** True when the model advertises tool calling. */
  tools?: boolean;
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  parameters?: string;
}

/**
 * Reads /api/show for one model. This is the only reliable way to learn the real
 * context length: /v1/models omits it entirely, so a client that trusts the
 * config default can send a prompt far larger than the server will accept.
 */
export async function ollamaShow(
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<OllamaModelInfo> {
  const root = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const res = await fetch(`${root}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`Ollama /api/show returned HTTP ${res.status}`);
  const payload = (await res.json()) as OllamaShowResponse;
  const info: OllamaModelInfo = {};

  // Keys look like "llama.context_length"; the largest is the model's maximum.
  let best = 0;
  for (const [key, value] of Object.entries(payload.model_info ?? {})) {
    if (!key.endsWith(".context_length")) continue;
    if (typeof value === "number" && value > best) best = value;
  }
  if (best > 0) info.contextLength = best;

  // Older daemons omit `capabilities`; fall back to the parameter block, where a
  // tools template shows up as a non-empty "tools" entry.
  if (Array.isArray(payload.capabilities)) {
    info.tools = payload.capabilities.includes("tools");
  } else if (typeof payload.parameters === "string") {
    info.tools = /(^|\n)\s*tools\b/.test(payload.parameters);
  }
  return info;
}
