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
import { ThinkTagSplitter, splitThinkTags } from "./ThinkTagSplitter.js";

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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  };
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  };
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

/**
 * Parses a tool call's JSON arguments. A model that emits a truncated or
 * malformed payload still yields a usable call: the raw text is preserved under
 * `__raw` so the observation can report it instead of losing the call.
 */
function parseArguments(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { __raw: raw ?? "" };
  }
}

/**
 * Reassembles tool calls that a stream delivers in pieces.
 *
 * OpenAI-style streaming splits one call across many deltas: the first frame
 * carries the id and name, later frames append argument fragments keyed by the
 * call's `index`. Arguments are concatenated as text and parsed once at the end,
 * because a partial JSON string is not parseable mid-flight.
 */
class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  /** Indices already handed to the caller, so a call is emitted exactly once. */
  private readonly flushed = new Set<number>();

  add(delta: NonNullable<NonNullable<OpenAIStreamChunk["choices"]>[number]["delta"]>["tool_calls"]): void {
    for (const fragment of delta ?? []) {
      const index = fragment.index ?? 0;
      const current = this.calls.get(index) ?? { id: "", name: "", args: "" };
      if (fragment.id !== undefined) current.id = fragment.id;
      if (fragment.function?.name !== undefined) current.name = fragment.function.name;
      if (fragment.function?.arguments !== undefined) current.args += fragment.function.arguments;
      this.calls.set(index, current);
    }
  }

  /**
   * Emits every call with an index below `index`. A new call index is the only
   * in-band signal that the previous call's arguments are finished, so this is
   * what lets a read-only tool start while the model is still streaming.
   */
  flushBefore(index: number, onCall?: (call: Extract<ContentBlock, { type: "tool_use" }>) => void): void {
    if (onCall === undefined) return;
    for (const key of [...this.calls.keys()].sort((a, b) => a - b)) {
      if (key >= index) break;
      this.flush(key, onCall);
    }
  }

  /** Emits every complete call; used at `finish_reason` and at `[DONE]`. */
  flushAll(onCall?: (call: Extract<ContentBlock, { type: "tool_use" }>) => void): void {
    if (onCall === undefined) return;
    for (const key of [...this.calls.keys()].sort((a, b) => a - b)) {
      this.flush(key, onCall);
    }
  }

  private flush(index: number, onCall: (call: Extract<ContentBlock, { type: "tool_use" }>) => void): void {
    if (this.flushed.has(index)) return;
    const call = this.calls.get(index);
    if (call === undefined || call.name.length === 0) return;
    this.flushed.add(index);
    onCall(this.toBlock(index, call));
  }

  /** Finished calls in index order, ready to become `tool_use` blocks. */
  build(): ContentBlock[] {
    const out: ContentBlock[] = [];
    for (const index of [...this.calls.keys()].sort((a, b) => a - b)) {
      const call = this.calls.get(index);
      if (call === undefined || call.name.length === 0) continue;
      out.push(this.toBlock(index, call));
    }
    return out;
  }

  private toBlock(index: number, call: { id: string; name: string; args: string }): Extract<ContentBlock, { type: "tool_use" }> {
    return {
      type: "tool_use",
      id: call.id.length > 0 ? call.id : `call_${index}`,
      name: call.name,
      input: parseArguments(call.args),
    };
  }
}

/** Mutable state carried across the frames of one stream. */
interface StreamState {
  text: string;
  reasoning: string;
  tools: ToolCallAccumulator;
  /** Splits inline ` thinking` scratchpads out of `delta.content`. */
  think: ThinkTagSplitter;
  finish: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  };
  sawUsage: boolean;
  /** Set when the `[DONE]` sentinel arrives; the reader must stop there. */
  done: boolean;
}

function newStreamState(): StreamState {
  return {
    text: "",
    reasoning: "",
    tools: new ToolCallAccumulator(),
    think: new ThinkTagSplitter(),
    finish: null,
    sawUsage: false,
    done: false,
  };
}

/**
 * Splits `buffer` into SSE frames, applying every complete one and returning the
 * unconsumed remainder. A frame is terminated by a blank line; a partial frame
 * stays in the buffer until the next read, so a chunk boundary mid-JSON is safe.
 */
function drainFrames(buffer: string, state: StreamState, args: CompletionArgs): string {
  let rest = buffer;
  for (;;) {
    const match = rest.match(/\r?\n\r?\n/);
    if (match === null || match.index === undefined) break;
    const frame = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    applyFrame(frame, state, args);
  }
  return rest;
}

/** Reads the `data:` payload out of one frame, or null when there is none. */
function frameData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length === 0 ? null : data.join("\n");
}

function applyFrame(frame: string, state: StreamState, args: CompletionArgs): void {
  const payload = frameData(frame);
  if (payload === null) return;
  const trimmed = payload.trim();
  if (trimmed.length === 0) return;
  // The sentinel closes the stream; there is nothing to accumulate from it.
  if (trimmed === "[DONE]") {
    state.tools.flushAll(args.onToolCall);
    state.done = true;
    return;
  }

  let chunk: OpenAIStreamChunk;
  try {
    chunk = JSON.parse(trimmed) as OpenAIStreamChunk;
  } catch {
    // A malformed frame is a transport artifact, not a reason to discard the
    // tokens already received: skip it and keep reading the stream.
    return;
  }

  if (chunk.usage !== undefined) {
    state.usage = chunk.usage;
    state.sawUsage = true;
  }

  const choice = chunk.choices?.[0];
  if (choice === undefined) return;

  const delta = choice.delta;
  if (delta?.reasoning_content) {
    state.reasoning += delta.reasoning_content;
    args.onReasoning?.(delta.reasoning_content, "reasoning_content");
  }
  if (delta?.content) {
    // Some thinking models emit the scratchpad inside `content` as
    // ` thinking...</think>`; route its interior to the reasoning channel so it
    // never reaches the rendered answer.
    const split = state.think.push(delta.content);
    if (split.reasoning.length > 0) {
      state.reasoning += split.reasoning;
      args.onReasoning?.(split.reasoning, "think-tag");
    }
    if (split.text.length > 0) {
      state.text += split.text;
      args.onText?.(split.text);
    }
  }
  if (delta?.tool_calls !== undefined) {
    const minIndex = Math.min(...delta.tool_calls.map((fragment) => fragment.index ?? 0));
    // A new index means the previous call's arguments are finished. Emitting it
    // here is what starts a read-only tool before the turn ends.
    state.tools.flushBefore(minIndex, args.onToolCall);
    state.tools.add(delta.tool_calls);
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    state.tools.flushAll(args.onToolCall);
    state.finish = choice.finish_reason;
  }
}

/**
 * Estimates the prompt size for a stream that never reports usage. Local
 * servers commonly omit the final usage frame, and a zero would make the cost
 * tracker believe the turn was free.
 */
function estimatePromptTokens(args: CompletionArgs): number {
  let total = estimateTokens(args.system);
  for (const message of args.messages) {
    for (const block of message.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "tool_result") total += estimateTokens(block.content);
      else total += estimateTokens(JSON.stringify(block.input ?? {}));
    }
  }
  return total;
}

/** Turns the accumulated stream state into the same shape as the JSON path. */
function finishStream(state: StreamState, args: CompletionArgs): LLMResponse {
  // A `</think>` that never arrived leaves text held back; release it so a lone
  // `<` at the tail is not silently dropped.
  const tail = state.think.flush();
  if (tail.reasoning.length > 0) {
    state.reasoning += tail.reasoning;
    args.onReasoning?.(tail.reasoning, "think-tag");
  }
  if (tail.text.length > 0) {
    state.text += tail.text;
    args.onText?.(tail.text);
  }
  const content: ContentBlock[] = [];
  if (state.text.length > 0) content.push({ type: "text", text: state.text });
  const toolCalls = state.tools.build();
  content.push(...toolCalls);

  const usage = state.sawUsage ? state.usage : undefined;
  return {
    content,
    stopReason: mapStopReason(state.finish, toolCalls.length > 0),
    usage: {
      inputTokens: usage?.prompt_tokens ?? estimatePromptTokens(args),
      outputTokens: usage?.completion_tokens ?? estimateTokens(state.text + state.reasoning),
      ...(cachedPromptTokens(usage) > 0 ? { cacheReadTokens: cachedPromptTokens(usage) } : {}),
    },
  };
}

/** OpenAI reports cached prompt tokens under `prompt_tokens_details`. */
function cachedPromptTokens(
  usage: { prompt_tokens_details?: { cached_tokens?: number | null } | null } | undefined,
): number {
  return usage?.prompt_tokens_details?.cached_tokens ?? 0;
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
      stream: this.streaming,
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
    // Ask for the final usage frame; without it a stream reports no token counts
    // and the cost tracker has to fall back to an estimate.
    if (this.streaming) {
      body.stream_options = { include_usage: true };
    }

    return await withRetry(
      () => this.requestOnce(body, args),
      this.onRetry !== undefined ? { onRetry: this.onRetry } : {},
    );
  }

  /**
   * One HTTP round trip. The transport decides the reader: a streaming endpoint
   * answers with `text/event-stream`, but plenty of gateways ignore `stream` and
   * send a single JSON body, so the response — not the request — picks the path.
   */
  private async requestOnce(
    body: Record<string, unknown>,
    args: CompletionArgs,
  ): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(this.streaming ? { accept: "text/event-stream" } : {}),
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
    const contentType = res.headers.get("content-type") ?? "";
    if (this.streaming && res.body !== null && /event-stream/i.test(contentType)) {
      return await this.consumeStream(res, args);
    }
    const raw = await res.text();
    // A stream-shaped body can arrive with a wrong content-type; sniff it so a
    // mislabelled endpoint still streams instead of failing to parse.
    if (this.streaming && /^\s*(data:|event:)/m.test(raw)) {
      return this.consumeSse(raw, args);
    }
    return this.fromJson(JSON.parse(raw) as OpenAIChatResponse, args);
  }

  /** Consumes an `text/event-stream` body, forwarding deltas as they arrive. */
  private async consumeStream(res: Response, args: CompletionArgs): Promise<LLMResponse> {
    const body = res.body;
    if (body === null) throw new FatalError("OpenAI-compat stream had no body.");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = newStreamState();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainFrames(buffer, state, args);
        // `[DONE]` is the protocol's end marker. Some gateways keep the socket
        // open after it, so waiting for the transport to close would hang the
        // turn forever; stop as soon as the sentinel is seen.
        if (state.done) break;
      }
      buffer += decoder.decode();
      drainFrames(`${buffer}\n`, state, args);
    } finally {
      if (state.done) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return finishStream(state, args);
  }

  /** Same as `consumeStream` for a body already buffered as text. */
  private consumeSse(raw: string, args: CompletionArgs): LLMResponse {
    const state = newStreamState();
    drainFrames(`${raw}\n`, state, args);
    return finishStream(state, args);
  }

  /**
   * Builds the response from a non-streaming JSON body. `onText` fires once with
   * the whole answer: a caller that wants deltas needs the streaming path.
   */
  private fromJson(response: OpenAIChatResponse, args: CompletionArgs): LLMResponse {
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI-compat response contained no choices.");
    }

    const content: ContentBlock[] = [];
    if (choice.message.reasoning_content) {
      args.onReasoning?.(choice.message.reasoning_content, "reasoning_content");
    }
    if (choice.message.content) {
      // The JSON path can carry the same inline ` thinking` scratchpad; split it
      // here so the reasoning block and the answer block stay separate.
      const split = splitThinkTags(choice.message.content);
      if (split.reasoning.length > 0) args.onReasoning?.(split.reasoning, "think-tag");
      if (split.text.length > 0) {
        content.push({ type: "text", text: split.text });
        args.onText?.(split.text);
      }
    }
    for (const call of choice.message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }

    return {
      content,
      stopReason: mapStopReason(choice.finish_reason, (choice.message.tool_calls ?? []).length > 0),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        ...(cachedPromptTokens(response.usage) > 0
          ? { cacheReadTokens: cachedPromptTokens(response.usage) }
          : {}),
      },
    };
  }
}
