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
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

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
   * splicing the model's private scratchpad into the answer.
   */
  onReasoning?: (chunk: string) => void;
}

export interface Provider {
  readonly name: string;
  complete(args: CompletionArgs): Promise<LLMResponse>;
}
