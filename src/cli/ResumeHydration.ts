import pc from "picocolors";

import type { Message } from "../types/llm.js";
import { userBlock } from "./MessageBlocks.js";

/**
 * Visual hydration for `--resume`.
 *
 * Reloading a session used to restore the model's history while leaving the
 * screen blank: the operator saw an empty transcript and had to trust that the
 * context was back. This replays the tail of the log as compact cards so the
 * screen matches the conversation the model is actually holding.
 *
 * Only the last few turns are painted, and only their human-readable parts. A
 * full replay would re-render every tool call and every file diff of a long
 * session, which is both slow and unreadable; the goal is orientation, not a
 * faithful scrollback.
 */

export interface HydrationOptions {
  /** How many user turns to replay from the end. */
  turns?: number;
  /** Maximum characters of assistant text shown per turn. */
  assistantChars?: number;
  /** Columns available, used to size the separator rule. */
  width?: number;
}

export interface HydratedTurn {
  user: string;
  assistant?: string;
  toolCalls: number;
}

/** Extracts the user's prose from a message, ignoring tool results. */
function userText(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) parts.push(block.text.trim());
  }
  return parts.join(" ").trim();
}

/** Extracts the assistant's prose and counts the tool calls it issued. */
function assistantParts(message: Message): { text: string; toolCalls: number } {
  const parts: string[] = [];
  let toolCalls = 0;
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) parts.push(block.text.trim());
    else if (block.type === "tool_use") toolCalls += 1;
  }
  return { text: parts.join(" ").trim(), toolCalls };
}

/**
 * Folds a message list into the last `turns` user turns, each paired with the
 * assistant text and tool-call count that followed it.
 */
export function summarizeTurns(history: Message[], turns: number): HydratedTurn[] {
  const result: HydratedTurn[] = [];
  let current: HydratedTurn | undefined;
  for (const message of history) {
    if (message.role === "user") {
      const text = userText(message);
      // A user message that is only tool results carries no prose; it belongs to
      // the assistant turn above, not to a new turn of its own.
      if (text.length === 0) continue;
      if (current !== undefined) result.push(current);
      current = { user: text, toolCalls: 0 };
    } else if (message.role === "assistant" && current !== undefined) {
      const { text, toolCalls } = assistantParts(message);
      if (text.length > 0) current.assistant = text;
      current.toolCalls += toolCalls;
    }
  }
  if (current !== undefined) result.push(current);
  return result.slice(-Math.max(1, turns));
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? text;
  return clip(line, max);
}

/**
 * Renders the hydrated tail as printable lines. The caller decides where they
 * go (viewport region or plain stderr), which keeps this module terminal-agnostic
 * and directly testable.
 */
export function resumeHydrationLines(history: Message[], options: HydrationOptions = {}): string[] {
  const turns = summarizeTurns(history, options.turns ?? 3);
  if (turns.length === 0) return [];
  const width = Math.max(20, options.width ?? 80);
  const assistantChars = options.assistantChars ?? 200;

  const rule = pc.gray("─".repeat(Math.max(8, Math.min(width - 20, 60))));
  const lines: string[] = [
    "",
    `${pc.cyan("◈")} ${pc.bold("Sesión rehidratada")} ${pc.gray(`· ${turns.length} turno(s) previo(s) recuperado(s)`)}`,
    rule,
  ];

  for (const turn of turns) {
    lines.push(...userBlock(clip(turn.user, width * 2), "ask"));
    const summaryBits: string[] = [];
    if (turn.toolCalls > 0) summaryBits.push(`${turn.toolCalls} herramienta(s)`);
    if (turn.assistant !== undefined && turn.assistant.length > 0) {
      summaryBits.push(firstLine(turn.assistant, assistantChars));
    }
    if (summaryBits.length > 0) {
      lines.push(`${pc.gray("│")} ${pc.gray(summaryBits.join(" · "))}`);
    }
  }

  lines.push(rule, "");
  return lines;
}

/**
 * Writes the hydrated tail through a sink. Kept separate from the line builder
 * so the REPL can route it to the chrome viewport and tests can capture it.
 */
export function writeResumeHydration(
  history: Message[],
  write: (text: string) => void,
  options: HydrationOptions = {},
): number {
  const lines = resumeHydrationLines(history, options);
  if (lines.length === 0) return 0;
  for (const line of lines) write(line);
  return summarizeTurns(history, options.turns ?? 3).length;
}

/** Counts user turns in a history, used by the resume banner. */
export function countTurns(history: Message[]): number {
  return history.filter((message) => message.role === "user").length;
}
