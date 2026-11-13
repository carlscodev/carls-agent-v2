import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatProvider } from "../src/providers/OpenAICompatProvider.js";
import type { CompletionArgs, LLMResponse } from "../src/types/llm.js";

/**
 * These tests drive the real `complete()` path over a stubbed `fetch`, so the
 * SSE reader (`consumeStream`), the frame splitter (`drainFrames`) and the
 * tool-call accumulator all run as they do against a live endpoint.
 */

const BASE_URL = "https://example.test/v1";

function args(overrides: Partial<CompletionArgs> = {}): CompletionArgs {
  return {
    system: "You are a test.",
    messages: [{ role: "user", content: [{ type: "text", text: "read a.ts" }] }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    model: "test-model",
    maxTokens: 256,
    ...overrides,
  };
}

/** A `Response` whose body is delivered in the given chunks, in order. */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A `Response` whose frames arrive over time, to observe when a callback fires. */
function timedStreamResponse(entries: { text: string; delayMs: number }[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const next = (): void => {
        const entry = entries[index++];
        if (entry === undefined) {
          controller.close();
          return;
        }
        setTimeout(() => {
          controller.enqueue(encoder.encode(entry.text));
          next();
        }, entry.delayMs);
      };
      next();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Splits every frame in half so no frame arrives whole. */
function splitEveryFrame(frames: string[]): string[] {
  const chunks: string[] = [];
  for (const frame of frames) {
    const middle = Math.floor(frame.length / 2);
    chunks.push(frame.slice(0, middle), frame.slice(middle));
  }
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible SSE streaming", () => {
  it("reassembles text, reasoning and a tool call split across frames", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"think."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      // One call, delivered in two frames: id and name first, arguments after.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];

    vi.stubGlobal("fetch", async () => streamResponse(splitEveryFrame(frames)));

    const text: string[] = [];
    const reasoning: string[] = [];
    const provider = new OpenAICompatProvider("test-key", BASE_URL);
    const response = await provider.complete(
      args({
        onText: (chunk) => text.push(chunk),
        onReasoning: (chunk) => reasoning.push(chunk),
      }),
    );

    // Deltas reach the caller as they arrive, not once at the end.
    expect(text.join("")).toBe("Hello world");
    expect(reasoning.join("")).toBe("Let me think.");

    const textBlock = response.content.find((block) => block.type === "text");
    expect(textBlock).toEqual({ type: "text", text: "Hello world" });

    const toolBlock = response.content.find((block) => block.type === "tool_use");
    expect(toolBlock).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "a.ts" },
    });

    expect(response.stopReason).toBe("tool_use");
    // No usage frame was sent, so the provider estimates rather than reporting 0.
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });

  it("maps a length finish reason to max_tokens", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"truncated"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", async () => streamResponse(splitEveryFrame(frames)));

    const response = await new OpenAICompatProvider("test-key", BASE_URL).complete(args());
    expect(response.stopReason).toBe("max_tokens");
  });

  it("emits a tool call as soon as the next index starts", async () => {
    const entries = [
      {
        delayMs: 0,
        text: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
      },
      {
        delayMs: 40,
        text: 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"glob_files","arguments":"{\\"pattern\\":\\"*.ts\\"}"}}]}}]}\n\n',
      },
      { delayMs: 40, text: 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' },
      { delayMs: 0, text: "data: [DONE]\n\n" },
    ];
    const emitted: { name: string; at: number }[] = [];
    const started = Date.now();
    vi.stubGlobal("fetch", async () => timedStreamResponse(entries));

    const response = await new OpenAICompatProvider("test-key", BASE_URL).complete(
      args({ onToolCall: (call) => emitted.push({ name: call.name, at: Date.now() - started }) }),
    );
    const completedAt = Date.now() - started;

    // The first call is flushed when index 1 opens, not at finish_reason: that
    // is what lets a read-only tool start while the model is still streaming.
    expect(emitted.map((entry) => entry.name)).toEqual(["read_file", "glob_files"]);
    expect(emitted[0]?.at).toBeLessThan(completedAt);
    expect(response.stopReason).toBe("tool_use");
    expect(response.content.filter((block) => block.type === "tool_use")).toHaveLength(2);
  });

  it("stops at [DONE] even when the server keeps the connection open", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // Deliberately never close: a gateway may keep the socket alive after
        // the sentinel, and waiting for the transport would hang the turn.
      },
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const response = await new OpenAICompatProvider("test-key", BASE_URL).complete(args());
    expect(response.content).toEqual([{ type: "text", text: "done" }]);
    expect(response.stopReason).toBe("end_turn");
  });

  it("ignores a malformed frame instead of losing the tokens already read", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"kept"}}]}\n\n',
      "data: {not json}\n\n",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", async () => streamResponse(splitEveryFrame(frames)));

    const response = await new OpenAICompatProvider("test-key", BASE_URL).complete(args());
    expect(response.content).toEqual([{ type: "text", text: "kept" }]);
    expect(response.stopReason).toBe("end_turn");
  });
});

describe("OpenAI-compatible JSON fallback", () => {
  const jsonBody = {
    choices: [
      {
        message: {
          content: "plain answer",
          reasoning_content: "plain reasoning",
          tool_calls: [
            {
              id: "call_json",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"b.ts"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };

  it("returns the same response as the non-streaming path when the endpoint ignores stream", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(jsonBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const streaming = new OpenAICompatProvider("test-key", BASE_URL);
    const nonStreaming = new OpenAICompatProvider("test-key", BASE_URL, undefined, {
      streaming: false,
    });

    const streamed: LLMResponse = await streaming.complete(args());
    const plain: LLMResponse = await nonStreaming.complete(args());

    expect(streamed).toEqual(plain);
    expect(streamed).toEqual({
      content: [
        { type: "text", text: "plain answer" },
        { type: "tool_use", id: "call_json", name: "read_file", input: { path: "b.ts" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it("sniffs a stream-shaped body that arrives with the wrong content-type", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"sniffed"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await new OpenAICompatProvider("test-key", BASE_URL).complete(args());
    expect(response.content).toEqual([{ type: "text", text: "sniffed" }]);
    expect(response.stopReason).toBe("end_turn");
  });
});
