import type { ContentBlock, Message, ToolSchema } from "../types/llm.js";

/**
 * Heuristic token estimator. No tokenizer is bundled: real tokenizers are
 * model-specific and heavy, so we approximate with chars/4 (English/code
 * average). Deliberately biased slightly high so compaction triggers early
 * rather than overflowing the window.
 */
const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "tool_use":
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input ?? {})) + 12;
    case "tool_result":
      return estimateTokens(block.content) + 8;
  }
}

export function estimateMessageTokens(message: Message): number {
  let total = 4;
  for (const block of message.content) {
    total += estimateBlockTokens(block);
  }
  return total;
}

export function estimateHistoryTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

export function estimateToolSchemaTokens(schemas: ToolSchema[]): number {
  let total = 0;
  for (const schema of schemas) {
    total += estimateTokens(schema.name) + estimateTokens(schema.description);
    total += estimateTokens(JSON.stringify(schema.input_schema));
  }
  return total;
}
