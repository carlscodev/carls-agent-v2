import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Message } from "../types/llm.js";

/**
 * Session export.
 *
 * A terminal session is the only record of how a change was reached, and it
 * lives in `~/.carls/sessions/*.jsonl` where nobody will read it. `/export`
 * turns it into markdown that can go into a PR description, an issue or a note.
 */

export interface ExportMeta {
  sessionId: string;
  model: string;
  cwd: string;
  /** ISO timestamp; defaults to now. */
  at?: string;
}

/** Tool output is clipped: an export is for a human, not for replaying. */
const MAX_BLOCK_CHARS = 4000;

function clip(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text;
  return `${text.slice(0, MAX_BLOCK_CHARS)}\n… ${text.length - MAX_BLOCK_CHARS} more characters`;
}

function fence(body: string, language = ""): string {
  // A body that already contains the fence needs a longer one, or the export
  // becomes unparseable exactly where the interesting output is.
  const closing = body.includes("```") ? "````" : "```";
  return `${closing}${language}\n${body}\n${closing}`;
}

function renderJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/** Renders a transcript as markdown, one section per message. */
export function renderTranscript(messages: Message[], meta: ExportMeta): string {
  const at = meta.at ?? new Date().toISOString();
  const lines: string[] = [
    `# carls session ${meta.sessionId}`,
    "",
    `- model: ${meta.model}`,
    `- cwd: ${meta.cwd}`,
    `- exported: ${at}`,
    `- messages: ${messages.length}`,
    "",
  ];

  for (const message of messages) {
    if (message.role === "system") continue;
    for (const block of message.content) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text.length === 0) continue;
        lines.push(`## ${message.role}`, "", text, "");
        continue;
      }
      if (block.type === "tool_use") {
        lines.push(`### tool call · ${block.name}`, "", fence(renderJson(block.input), "json"), "");
        continue;
      }
      lines.push(
        `### tool result · ${block.is_error ? "error" : "ok"}`,
        "",
        fence(clip(block.content), ""),
        "",
      );
    }
  }
  return lines.join("\n");
}

export interface ExportResult {
  path: string;
  bytes: number;
}

/** Writes the transcript, creating the directory if the caller named one. */
export async function writeTranscript(
  path: string,
  messages: Message[],
  meta: ExportMeta,
): Promise<ExportResult> {
  const target = resolve(path);
  const body = `${renderTranscript(messages, meta)}\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");
  return { path: target, bytes: Buffer.byteLength(body, "utf8") };
}
