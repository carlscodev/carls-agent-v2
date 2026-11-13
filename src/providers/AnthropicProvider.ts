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

type AnthropicMessageStream = ReturnType<Anthropic["messages"]["stream"]>;

/**
 * Resolves as soon as the protocol's `message_stop` has produced the final
 * message, then aborts the stream.
 *
 * The SDK's `finalMessage()` waits for the underlying `for await` to finish,
 * which only happens when the HTTP body closes. An SSE gateway or a keep-alive
 * proxy may leave that socket open after `message_stop`, so awaiting it leaves
 * the turn pending forever: the answer is on screen, but the REPL never gets
 * the prompt back. The `message` event is emitted exactly at `message_stop`
 * with the complete snapshot, so that is the correct completion signal.
 */
function waitForFinalMessage(
  stream: AnthropicMessageStream,
  signal?: AbortSignal,
): Promise<Anthropic.Message> {
  return new Promise<Anthropic.Message>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      stream.off("message", onMessage);
      stream.off("streamEvent", onStreamEvent);
      stream.off("end", onEnd);
      signal?.removeEventListener("abort", onSignalAbort);
      // The error/abort listeners stay attached on purpose: aborting a settled
      // stream makes the SDK emit `abort`, and with no listener it turns that
      // into an unhandled rejection. They are no-ops once `settled` is true.
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const closeWith = (message: Anthropic.Message): void => {
      finish(() => {
        // Release the socket instead of waiting for a keep-alive peer to close
        // it; the message is already complete at this point.
        try {
          stream.abort();
        } catch {
          // The stream may already be closed; the message is still good.
        }
        resolve(message);
      });
    };
    const onMessage = (message: Anthropic.Message): void => closeWith(message);
    // The SDK's SSE splitter misses a final `\n\n` when it lands at the end of
    // the last chunk (the index loop stops two bytes early), so `message_stop`
    // can stay buffered forever on a keep-alive socket. `message_delta` carries
    // the final stop_reason and the complete snapshot, which is an equivalent
    // end signal and arrives one frame earlier.
    const onStreamEvent = (
      event: Anthropic.MessageStreamEvent,
      snapshot: Anthropic.Message,
    ): void => {
      if (event.type === "message_stop") closeWith(snapshot);
      else if (event.type === "message_delta" && event.delta.stop_reason !== null) {
        closeWith(snapshot);
      }
    };
    const onError = (error: Error): void => finish(() => reject(error));
    const onAbort = (error: Error): void => finish(() => reject(error));
    const onEnd = (): void =>
      finish(() => reject(new Error("The stream ended before producing a final message.")));
    const onSignalAbort = (): void => {
      finish(() => reject(new Error("The request was aborted.")));
      try {
        stream.abort();
      } catch {
        // Already closed.
      }
    };

    stream.on("message", onMessage);
    stream.on("streamEvent", onStreamEvent);
    stream.on("error", onError);
    stream.on("abort", onAbort);
    stream.on("end", onEnd);
    if (signal !== undefined) {
      if (signal.aborted) onSignalAbort();
      else signal.addEventListener("abort", onSignalAbort, { once: true });
    }
  });
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
    // turn completes at `message_stop` rather than at transport close.
    const response = await withRetry(
      async () => {
        const stream = this.client.messages.stream(request, { signal: args.signal });
        if (args.onText) {
          stream.on("text", (delta: string) => args.onText?.(delta));
        }
        return await waitForFinalMessage(stream, args.signal);
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
