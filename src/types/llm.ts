export type Role = "system" | "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache, when reported. */
  cacheReadTokens?: number;
  /** Prompt tokens written to the cache on this call, when reported. */
  cacheWriteTokens?: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

/** Which provider field carried a reasoning delta, for the panel's provenance. */
export type ReasoningSource = "reasoning_content" | "reasoning" | "thinking" | "think-tag";

export interface CompletionArgs {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  model: string;
  maxTokens: number;
  /** Reasoning effort hint; only forwarded by providers that support it. */
  effort?: "minimal" | "low" | "medium" | "high";
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  /**
   * Reasoning deltas from a thinking model (`reasoning_content`). Kept separate
   * from `onText` so the UI can render it as its own dim block instead of
   * splicing the model's private scratchpad into the answer. `source` names the
   * field it came from so the panel can show its provenance; it defaults to
   * `reasoning_content` when a provider does not distinguish.
   */
  onReasoning?: (chunk: string, source?: ReasoningSource) => void;
  /**
   * Fires as soon as a `tool_use` block is complete in the stream, before the
   * turn ends. Read-only calls can start executing while the model is still
   * emitting text; a provider that cannot stream tool calls simply never calls
   * this, and the loop falls back to executing after `complete()` resolves.
   */
  onToolCall?: (call: Extract<ContentBlock, { type: "tool_use" }>) => void;
}

export interface Provider {
  readonly name: string;
  complete(args: CompletionArgs): Promise<LLMResponse>;
}
