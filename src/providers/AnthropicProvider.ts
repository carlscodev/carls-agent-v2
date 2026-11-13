import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionArgs,
  ContentBlock,
  LLMResponse,
  Message,
  Provider,
  StopReason,
  ToolSchema,
} from "../types/llm.js";
import { withRetry } from "./retry.js";

type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicBlockParam =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

function toAnthropicMessages(messages: Message[]): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const content: AnthropicBlockParam[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      } else {
        content.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        });
      }
    }
    out.push({ role: message.role, content });
  }
  return out;
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function mapContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return out;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey,
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    });
  }

  async complete(args: CompletionArgs): Promise<LLMResponse> {
    const tools = args.tools.map((schema: ToolSchema) => ({
      name: schema.name,
      description: schema.description,
      input_schema: schema.input_schema as Anthropic.Tool.InputSchema,
    }));

    const request = {
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: toAnthropicMessages(args.messages),
      tools,
    };

    // Real token streaming: text deltas are forwarded as they arrive, and the
    // final message is awaited once the stream completes.
    const response = await withRetry(
      async () => {
        const stream = this.client.messages.stream(request, { signal: args.signal });
        if (args.onText) {
          stream.on("text", (delta: string) => args.onText?.(delta));
        }
        return stream.finalMessage();
      },
      {
        onRetry: (attempt, delay) =>
          process.stderr.write(`[warn] anthropic retry ${attempt} in ${delay}ms\n`),
      },
    );

    const usage = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    return {
      content: mapContent(response.content),
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens > 0
          ? { cacheReadTokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens > 0
          ? { cacheWriteTokens: usage.cache_creation_input_tokens }
          : {}),
      },
    };
  }
}
