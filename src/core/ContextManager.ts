import type { ContentBlock, Message } from "../types/llm.js";
import type { Checkpoint } from "../types/agent.js";
import { estimateHistoryTokens } from "../utils/tokens.js";
import { truncate } from "../utils/truncate.js";

export interface ContextManagerOptions {
  contextWindow: number;
  compactThreshold: number;
  truncateLimit: number;
  /** Messages kept verbatim at the tail after a compaction pass. */
  keepRecent?: number;
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  checkpoint?: Checkpoint;
}

export type Summarizer = (
  older: Message[],
  hint: { goal: string; filesTouched: string[] },
) => Promise<Checkpoint>;

export class ContextManager {
  private contextWindow: number;
  private readonly compactThreshold: number;
  private readonly truncateLimit: number;
  private readonly keepRecent: number;

  constructor(options: ContextManagerOptions) {
    this.contextWindow = options.contextWindow;
    this.compactThreshold = options.compactThreshold;
    this.truncateLimit = options.truncateLimit;
    this.keepRecent = options.keepRecent ?? 8;
  }

  /**
   * Adopts the window the endpoint actually reports. A local server often runs a
   * smaller window than the registry assumes, and compaction that never fires is
   * how a session silently truncates instead of summarising.
   */
  setContextWindow(tokens: number): void {
    if (tokens > 0) this.contextWindow = tokens;
  }

  window(): number {
    return this.contextWindow;
  }

  usedRatio(messages: Message[]): number {
    return estimateHistoryTokens(messages) / this.contextWindow;
  }

  shouldCompact(messages: Message[]): boolean {
    return this.usedRatio(messages) >= this.compactThreshold;
  }

  /** Recorta una observación larga antes de inyectarla en el historial. */
  truncateObservation(text: string): string {
    return truncate(text, this.truncateLimit).text;
  }

  /**
   * Splits history at a tool-pair-safe boundary. A `tool_result` must stay with
   * the assistant `tool_use` that produced it, otherwise the provider rejects
   * the request, so we walk the cut backwards past any tool_result-only turn.
   */
  private safeCutIndex(messages: Message[]): number {
    let cut = Math.max(0, messages.length - this.keepRecent);
    while (cut > 0 && cut < messages.length) {
      const message = messages[cut];
      if (message === undefined) break;
      const onlyToolResults =
        message.role === "user" &&
        message.content.length > 0 &&
        message.content.every((block) => block.type === "tool_result");
      if (!onlyToolResults) break;
      cut--;
    }
    return cut;
  }

  async compact(
    messages: Message[],
    goal: string,
    filesTouched: Set<string>,
    summarize: Summarizer,
  ): Promise<CompactionResult> {
    const cut = this.safeCutIndex(messages);
    if (cut <= 0) {
      // Nothing older than the retained tail; still let the caller truncate.
      return { messages, compacted: false };
    }

    const older = messages.slice(0, cut);
    const recent = messages.slice(cut);
    const checkpoint = await summarize(older, { goal, filesTouched: [...filesTouched] });

    const summaryText = [
      "[contexto compactado]",
      `Objetivo: ${checkpoint.goal}`,
      checkpoint.summary.length > 0 ? `Progreso: ${checkpoint.summary}` : "",
      checkpoint.filesTouched.length > 0
        ? `Archivos tocados: ${checkpoint.filesTouched.join(", ")}`
        : "",
      checkpoint.errorsResolved.length > 0
        ? `Errores resueltos: ${checkpoint.errorsResolved.join("; ")}`
        : "",
      `Siguiente paso: ${checkpoint.nextStep}`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    const summaryMessage: Message = {
      role: "user",
      content: [{ type: "text", text: summaryText }],
    };

    return {
      messages: [summaryMessage, ...recent],
      compacted: true,
      checkpoint,
    };
  }

  /** Deterministic, LLM-free checkpoint used as a fallback summarizer. */
  static heuristicCheckpoint(
    older: Message[],
    hint: { goal: string; filesTouched: string[] },
  ): Checkpoint {
    const touched = new Set<string>(hint.filesTouched);
    const errors: string[] = [];
    const toolNames: string[] = [];

    for (const message of older) {
      for (const block of message.content) {
        if (block.type === "tool_use") {
          toolNames.push(block.name);
          const path = extractPath(block.input);
          if (path !== undefined) touched.add(path);
        } else if (block.type === "tool_result" && block.is_error) {
          errors.push(block.content.slice(0, 120));
        }
      }
    }

    const counts = new Map<string, number>();
    for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
    const toolSummary = [...counts.entries()]
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");

    return {
      goal: hint.goal,
      filesTouched: [...touched],
      errorsResolved: errors.slice(0, 5),
      summary: `Se resumieron ${older.length} mensajes previos. Herramientas usadas: ${toolSummary || "ninguna"}.`,
      nextStep: "Continuar desde el estado actual sin re-leer archivos ya explorados.",
    };
  }
}

function extractPath(input: unknown): string | undefined {
  if (input !== null && typeof input === "object" && "path" in input) {
    const value = (input as { path?: unknown }).path;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Convenience used by the REPL `/context` command. */
export function contextReport(messages: Message[], contextWindow: number): string {
  const tokens = estimateHistoryTokens(messages);
  const pct = ((tokens / contextWindow) * 100).toFixed(1);
  const chars = messages.reduce(
    (total, message) =>
      total +
      message.content.reduce(
        (sum, block: ContentBlock) => sum + (block.type === "text" ? block.text.length : 0),
        0,
      ),
    0,
  );
  return `~${tokens.toLocaleString()} tokens (${pct}% of ${contextWindow.toLocaleString()}) · ${messages.length} messages · ${chars.toLocaleString()} chars`;
}
