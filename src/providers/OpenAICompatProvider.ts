import type {
  CompletionArgs,
  ContentBlock,
  LLMResponse,
  Message,
  Provider,
  StopReason,
} from "../types/llm.js";
import { withRetry, httpError, FatalError } from "./retry.js";
import { estimateTokens } from "../utils/tokens.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChatResponse {
  choices: {
    message: {
      content: string | null;
      /** Present on thinking models (DeepSeek, Qwen, GLM): the scratchpad. */
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** One `data:` frame of a chat-completions stream. */
interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAIMessages(system: string, messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls: OpenAIToolCall[] = message.content
        .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      const entry: OpenAIMessage = { role: "assistant", content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    // user turn: tool_result blocks become "tool" messages, text becomes user.
    const textBlocks = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
    );
    if (textBlocks.length > 0) {
      out.push({ role: "user", content: textBlocks.map((block) => block.text).join("") });
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          content: block.content,
          tool_call_id: block.tool_use_id,
        });
      }
    }
  }
  return out;
}

function mapStopReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

export interface OpenAICompatOptions {
  /**
   * Whether the endpoint accepts `reasoning_effort`. Local servers and the
   * Ollama /v1 shim do not, and a strict server rejects the unknown field.
   */
  supportsReasoningEffort?: boolean;
  /**
   * Whether to ask for a token stream. On by default; a caller can turn it off
   * for an endpoint that ignores `stream` or rejects `stream_options`.
   */
  streaming?: boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  private readonly supportsReasoningEffort: boolean;
  private readonly streaming: boolean;

  constructor(
    apiKey: string,
    baseUrl?: string,
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
    options: OpenAICompatOptions = {},
  ) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.name = "openai-compat";
    this.supportsReasoningEffort = options.supportsReasoningEffort === true;
    this.streaming = options.streaming !== false;
    const retry = onRetry ?? options.onRetry;
    if (retry !== undefined) this.onRetry = retry;
  }

  async complete(args: CompletionArgs): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: args.model,
      max_tokens: args.maxTokens,
      stream: false,
      messages: toOpenAIMessages(args.system, args.messages),
      tools: args.tools.map((schema) => ({
        type: "function" as const,
        function: {
          name: schema.name,
          description: schema.description,
          parameters: schema.input_schema,
        },
      })),
    };
    // Only send the field to endpoints that understand it; local servers either
    // reject it or ignore it, and it inflates the prompt for no benefit.
    if (args.effort !== undefined && this.supportsReasoningEffort) {
      body.reasoning_effort = args.effort;
    }

    const response = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs =
          retryAfterHeader !== null && Number.isFinite(Number.parseFloat(retryAfterHeader))
            ? Math.max(0, Number.parseFloat(retryAfterHeader) * 1000)
            : undefined;
        throw httpError(
          res.status,
          `OpenAI-compat HTTP ${res.status}: ${text.slice(0, 500)}`,
          retryAfterMs,
        );
      }
      return (await res.json()) as OpenAIChatResponse;
    }, this.onRetry !== undefined ? { onRetry: this.onRetry } : {});

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI-compat response contained no choices.");
    }

    const content: ContentBlock[] = [];
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
      args.onText?.(choice.message.content);
    }
    for (const call of choice.message.tool_calls ?? []) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = { __raw: call.function.arguments };
      }
      content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parsed });
    }

    return {
      content,
      stopReason: mapStopReason(choice.finish_reason, (choice.message.tool_calls ?? []).length > 0),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
