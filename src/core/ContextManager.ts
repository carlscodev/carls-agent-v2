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
  /**
   * Ratio at which old observations are masked before a full compaction. Below
   * the compaction threshold on purpose: masking is lossless for reasoning (the
   * call and its outcome stay), while compaction replaces whole turns with a
   * summary, so it is worth trying the cheaper pass first.
   */
  maskThreshold?: number;
  /** Observations shorter than this are never masked: the digest would cost more. */
  maskMinChars?: number;
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
  private readonly maskThreshold: number;
  private readonly maskMinChars: number;

  constructor(options: ContextManagerOptions) {
    this.contextWindow = options.contextWindow;
    this.compactThreshold = options.compactThreshold;
    this.truncateLimit = options.truncateLimit;
    this.keepRecent = options.keepRecent ?? 8;
    this.maskThreshold = options.maskThreshold ?? 0.6;
    this.maskMinChars = options.maskMinChars ?? 1200;
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

  /** How many observations the last `maskObservations` call replaced. */
  lastMaskedCount = 0;

  /** True when history is large enough that masking old observations is worth it. */
  shouldMask(messages: Message[]): boolean {
    return this.usedRatio(messages) >= this.maskThreshold;
  }

  /**
   * Replaces the body of old `tool_result` blocks with a one-line digest.
   *
   * This is the cheap pass before a full compaction. It never removes a block and
   * never reorders anything, so a `tool_use`/`tool_result` pair always stays
   * intact and the provider still accepts the request. What is lost is the raw
   * text of an observation the agent has already acted on; the digest keeps the
   * fact that the call happened and whether it succeeded.
   *
   * The recent tail is left alone: that is where the current reasoning lives.
   */
  maskObservations(messages: Message[], keepTail = this.keepRecent * 2): Message[] {
    const cut = Math.max(0, messages.length - keepTail);
    let masked = 0;

    const next = messages.map((message, index) => {
      if (index >= cut) return message;
      // Only the user-side tool_result carrier is touched; assistant turns and
      // user text are left verbatim.
      if (message.role !== "user") return message;
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "tool_result") return block;
        if (block.content.length < this.maskMinChars) return block;
        // A failure the agent may still be fixing keeps its detail.
        if (block.is_error && block.content.length < this.maskMinChars * 3) return block;
        changed = true;
        masked++;
        return { ...block, content: digest(block.content, block.is_error) };
      });
      return changed ? { ...message, content } : message;
    });

    this.lastMaskedCount = masked;
    return masked > 0 ? next : messages;
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

/**
 * Compresses one observation into a single line that keeps its outcome.
 *
 * The digest is extracted from the text, never invented: the exit code, a test
 * tally, an error count or the size of the output. When nothing recognisable is
 * found it falls back to a size marker, which is still enough for the model to
 * know the call happened and roughly what came back.
 */
export function digest(content: string, isError: boolean): string {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const facts: string[] = [];

  // Exit code as reported by the bash tool.
  const exit = content.match(/\[exit code\]\s*(-?\d+|null)/);
  if (exit?.[1] !== undefined) facts.push(`exit ${exit[1]}`);

  // A test tally. Runners disagree on the shape: vitest prints "Tests  186 passed",
  // mocha prints "186 passing", jest prints "2 failing" with no noun at all, so a
  // bare "<n> passed/passing" (or failed/failing) counts too. Without that last
  // alternative a mocha or jest observation was digested with no tally at all.
  const passed = content.match(
    /(?:tests?|specs?)\s+(\d+)\s+(?:passed|passing|ok)\b|(\d+)\s+(?:tests?|specs?)\s+(?:passed|passing|ok)\b|(\d+)\s+(?:passed|passing)\b/i,
  );
  if (passed !== null) {
    const count = passed[1] ?? passed[2] ?? passed[3];
    if (count !== undefined) facts.push(`${count} tests ok`);
  }
  const failed = content.match(
    /(?:tests?|specs?)\s+(\d+)\s+(?:failed|failing)\b|(\d+)\s+(?:tests?|specs?)\s+(?:failed|failing)\b|(\d+)\s+(?:failed|failing)\b/i,
  );
  if (failed !== null) {
    const count = failed[1] ?? failed[2] ?? failed[3];
    if (count !== undefined) facts.push(`${count} failed`);
  }

  // A build/test error count.
  const errors = content.match(/(\d+)\s+errors?\b/i);
  if (errors?.[1] !== undefined) facts.push(`${errors[1]} errors`);

  // A unified diff, which the model does not need to re-read after the fact.
  const hunks = content.match(/^@@/gm);
  if (hunks !== null && hunks.length > 0) facts.push(`${hunks.length} hunks`);

  const kind = isError ? "failed" : "ok";
  const head = `[observation masked · ${kind}`;
  const detail = facts.length > 0 ? ` · ${facts.join(", ")}` : "";
  const shape = `${lines.length} lines, ${content.length} chars`;
  return `${head}${detail} · ${shape}]`;
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
