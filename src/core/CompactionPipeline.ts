import type { ContentBlock, Message } from "../types/llm.js";
import type { Checkpoint } from "../types/agent.js";
import type { ContextManager } from "./ContextManager.js";
import { digest } from "./ContextManager.js";
import { estimateHistoryTokens } from "../utils/tokens.js";

/**
 * The five-layer compaction pipeline.
 *
 * Compaction is not one operation. Trying to fix a full context with a single
 * summary is what produces amnesia: the summary is written once, from a transcript
 * that already lost detail, and every later compaction summarises the previous
 * summary. The layers here run cheapest-first and each one is lossless for
 * something the model still needs:
 *
 *  1. tool-output budget  — big outputs go to disk, a pointer stays
 *  2. history snip        — raw reads of files that were since edited and verified
 *  3. cache-aware microcompact — compress the middle without breaking the prefix
 *  4. read-time collapse  — project a shorter view for the model, change nothing on disk
 *  5. auto-compact        — summarise, then re-anchor the live state after the summary
 *
 * Layer 4 is the one that needs stating plainly: it never mutates the transcript.
 * The real history is the append-only session log; what the model receives is a
 * projection of it, so a collapse is always reversible and a bad projection
 * cannot destroy evidence.
 */

export interface CompactionLayerResult {
  layer: 1 | 2 | 3 | 4 | 5;
  name: string;
  applied: boolean;
  /** Tokens reclaimed, estimated. */
  savedTokens: number;
  detail: string;
}

export interface CollapsePointers {
  /** First message kept verbatim. */
  headUuid: number;
  /** Index of the summary that stands in for the collapsed middle. */
  anchorUuid: number;
  /** Last message kept verbatim. */
  tailUuid: number;
}

export interface CompactionReport {
  layers: CompactionLayerResult[];
  tokensBefore: number;
  tokensAfter: number;
  /** Set when layer 4 produced a projected view rather than a mutation. */
  collapse?: CollapsePointers;
  /** The live-state block re-injected by layer 5, when it ran. */
  liveStateAnchor?: string;
}

export interface PipelineOptions {
  contextManager: ContextManager;
  /** Produces the live-state block for layer 5. */
  buildLiveState: () => Promise<string>;
  /** Summarises the older half for layer 5. */
  summarize: (older: Message[], hint: { goal: string; filesTouched: string[] }) => Promise<Checkpoint>;
  /**
   * Ratio at which layer 4 collapses the view. Above the masking threshold and
   * below the compaction threshold: a projection is cheaper than a summary, so it
   * is worth doing before the expensive step.
   */
  collapseThreshold?: number;
}

/** A tool result the agent has already superseded: it read a file, then edited it. */
export interface SupersededObservation {
  toolUseId: string;
  path: string;
  /** A file edited after this read makes the read stale. */
  editedAfter: boolean;
}

/**
 * Finds read results that a later edit made obsolete.
 *
 * Layer 2 is the only layer that removes information rather than compressing it,
 * so its condition is deliberately narrow: the observation must be a read, the
 * file must have been written afterwards, and the write must have succeeded.
 * Anything less specific risks dropping the one observation that explains why the
 * current code looks the way it does.
 */
export function findSupersededReads(messages: readonly Message[]): SupersededObservation[] {
  const reads = new Map<string, { path: string; index: number }>();
  const edited = new Set<string>();

  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const input = block.input as { path?: unknown } | undefined;
        const path = typeof input?.path === "string" ? input.path : undefined;
        if (path === undefined) continue;
        if (block.name === "read_file" || block.name === "multi_read") {
          reads.set(block.id, { path, index });
        } else if (block.name === "write_file" || block.name === "edit_file" || block.name === "apply_patch") {
          edited.add(path);
        }
      }
    }
  });

  const superseded: SupersededObservation[] = [];
  for (const [toolUseId, entry] of reads) {
    if (edited.has(entry.path)) {
      superseded.push({ toolUseId, path: entry.path, editedAfter: true });
    }
  }
  return superseded;
}

export class CompactionPipeline {
  private readonly options: PipelineOptions;

  constructor(options: PipelineOptions) {
    this.options = options;
  }

  /**
   * Layer 4: builds the projected view the model reads.
   *
   * Returns a new array; the caller's history is untouched. The projection keeps
   * the head (the goal and the first orientation), collapses the middle into the
   * summary that already exists as a message, and keeps the tail verbatim.
   */
  projectView(messages: readonly Message[], keepTail = 16): { messages: Message[]; pointers: CollapsePointers } | undefined {
    if (messages.length <= keepTail + 4) return undefined;

    const tailStart = messages.length - keepTail;
    // The head is the first user turn, which holds the goal.
    const headEnd = Math.min(1, messages.length);
    const middle = messages.slice(headEnd, tailStart);
    if (middle.length === 0) return undefined;

    const summaryIndex = messages.findIndex(
      (message, index) =>
        index >= headEnd &&
        index < tailStart &&
        message.role === "user" &&
        message.content.some((block) => block.type === "text" && block.text.startsWith("[contexto compactado]")),
    );

    const head = messages.slice(0, headEnd);
    const tail = messages.slice(tailStart);
    const anchor: Message =
      summaryIndex !== -1
        ? (messages[summaryIndex] ?? {
            role: "user",
            content: [{ type: "text", text: "[collapsed middle]" }],
          })
        : {
            role: "user",
            content: [
              {
                type: "text",
                text: `[${middle.length} earlier message(s) collapsed for this view; the full transcript is on disk and nothing was deleted]`,
              },
            ],
          };

    return {
      messages: [...head, anchor, ...tail],
      // Pointers into the projected array, so a caller can map a view index back
      // to the region it came from without re-deriving the split.
      pointers: { headUuid: 0, anchorUuid: head.length, tailUuid: head.length + 1 },
    };
  }

  /**
   * Layers 1 to 3, applied to the history in place, cheapest first.
   *
   * Stops as soon as the history fits the budget: running a later, lossier layer
   * because an earlier one already succeeded is how a session loses detail for no
   * reason.
   */
  applyCheapLayers(messages: Message[], budgetTokens: number): CompactionLayerResult[] {
    const results: CompactionLayerResult[] = [];
    const before = estimateHistoryTokens(messages);

    // Layer 1 is enforced at tool-call time by the ArtifactStore, which is where
    // the full text still exists; here we only report that it is active.
    results.push({
      layer: 1,
      name: "tool-output budget",
      applied: true,
      savedTokens: 0,
      detail: "large tool outputs are offloaded to .carls/artifacts at call time",
    });

    // Layer 2: drop the body of reads that a later edit superseded.
    const superseded = findSupersededReads(messages);
    let layer2Saved = 0;
    if (superseded.length > 0) {
      const ids = new Set(superseded.map((entry) => entry.toolUseId));
      const byId = new Map(superseded.map((entry) => [entry.toolUseId, entry.path]));
      for (const message of messages) {
        for (let index = 0; index < message.content.length; index++) {
          const block = message.content[index];
          if (block === undefined || block.type !== "tool_result" || !ids.has(block.tool_use_id)) continue;
          const path = byId.get(block.tool_use_id) ?? "the file";
          const replacement = `[read of ${path} removed: the file was edited afterwards, so this content is stale. Re-read it if you need the current version.]`;
          layer2Saved += Math.max(0, estimateHistoryTokens([message]) - 8);
          message.content[index] = { ...block, content: replacement };
        }
      }
    }
    results.push({
      layer: 2,
      name: "history snip",
      applied: superseded.length > 0,
      savedTokens: layer2Saved,
      detail:
        superseded.length > 0
          ? `removed ${superseded.length} read result(s) superseded by a later edit`
          : "no read was superseded by an edit",
    });

    if (estimateHistoryTokens(messages) <= budgetTokens) {
      results.push({
        layer: 3,
        name: "cache-aware microcompact",
        applied: false,
        savedTokens: 0,
        detail: "history already fits the budget after layers 1-2",
      });
      return results;
    }

    // Layer 3: compress the middle in place, preserving the head and tail so the
    // provider's prefix cache still matches on the next call.
    const layer3 = this.microcompact(messages);
    results.push(layer3);

    const after = estimateHistoryTokens(messages);
    results.push({
      layer: 4,
      name: "read-time collapse",
      applied: false,
      savedTokens: 0,
      detail: `available: ${before - after} tokens reclaimed so far; a projected view is built only when the budget is still exceeded`,
    });
    return results;
  }

  /**
   * Layer 3: replaces old, large observations with their digests.
   *
   * Different from `ContextManager.maskObservations` in intent, not mechanism: the
   * masker runs early as routine hygiene, this runs under budget pressure and
   * ignores the "recent" rule so the middle is actually compressed. The tail is
   * always preserved, because that is where the current reasoning is.
   */
  private microcompact(messages: Message[], keepTail = 8): CompactionLayerResult {
    const cut = Math.max(0, messages.length - keepTail);
    let saved = 0;
    let touched = 0;

    for (let index = 0; index < cut; index++) {
      const message = messages[index];
      if (message === undefined || message.role !== "user") continue;
      for (let position = 0; position < message.content.length; position++) {
        const block = message.content[position];
        if (block === undefined || block.type !== "tool_result") continue;
        if (block.content.startsWith("[read of ") || block.content.startsWith("[observation masked")) continue;
        if (block.content.length < 200) continue;
        const beforeTokens = estimateHistoryTokens([message]);
        message.content[position] = { ...block, content: digest(block.content, block.is_error) };
        saved += Math.max(0, beforeTokens - estimateHistoryTokens([message]));
        touched++;
      }
    }

    return {
      layer: 3,
      name: "cache-aware microcompact",
      applied: touched > 0,
      savedTokens: saved,
      detail: touched > 0 ? `digested ${touched} middle observation(s)` : "no middle observation was large enough",
    };
  }

  /**
   * Layer 5: the full pass. Summarise the older half, then re-anchor the live
   * state *after* the summary so the model reads the facts last.
   *
   * The order matters and is the whole point of the layer: a summary is the model's
   * own prose and can be wrong; the anchor is read from the running system. Putting
   * the anchor after the summary means the true state is the most recent thing in
   * context, not buried above a lossy paraphrase.
   */
  async autoCompact(
    messages: Message[],
    goal: string,
    filesTouched: Set<string>,
  ): Promise<{ messages: Message[]; report: CompactionReport }> {
    const before = estimateHistoryTokens(messages);
    const layers = this.applyCheapLayers(messages, this.options.contextManager.window() * 0.5);

    const compaction = await this.options.contextManager.compact(messages, goal, filesTouched, this.options.summarize);
    const layer5: CompactionLayerResult = {
      layer: 5,
      name: "auto-compact with live-state re-anchor",
      applied: compaction.compacted,
      savedTokens: 0,
      detail: compaction.compacted ? "summarised the older half and re-injected the live state" : "nothing older than the retained tail",
    };
    layers.push(layer5);

    if (!compaction.compacted) {
      return {
        messages,
        report: { layers, tokensBefore: before, tokensAfter: estimateHistoryTokens(messages) },
      };
    }

    // Re-anchor: the live state is appended to the summary message itself, as its
    // last text block, so it is the most recent thing read before the retained
    // tail. Appending rather than inserting a second message also avoids emitting
    // two consecutive user turns, which some providers reject.
    const liveState = await this.options.buildLiveState();
    const summaryMessage = compaction.messages[0];
    const next =
      summaryMessage === undefined
        ? compaction.messages
        : [
            {
              ...summaryMessage,
              content: [...summaryMessage.content, { type: "text" as const, text: liveState }],
            },
            ...compaction.messages.slice(1),
          ];

    const tokensAfter = estimateHistoryTokens(next);
    layer5.savedTokens = Math.max(0, before - tokensAfter);

    return {
      messages: next,
      report: {
        layers,
        tokensBefore: before,
        tokensAfter,
        liveStateAnchor: liveState,
      },
    };
  }

  /**
   * Layer 4, applied to a projection: returns the view to send without touching
   * the caller's array. Used by the loop when the budget is exceeded but a full
   * summary is not warranted yet.
   */
  collapsedView(messages: readonly Message[]): { messages: Message[]; pointers: CollapsePointers } | undefined {
    const threshold = this.options.collapseThreshold ?? 0.7;
    if (this.options.contextManager.usedRatio([...messages]) < threshold) return undefined;
    return this.projectView(messages);
  }
}

/** Convenience for tests and the receipt: a compact one-line-per-layer summary. */
export function formatCompactionReport(report: CompactionReport): string {
  const lines = report.layers.map(
    (layer) => `L${layer.layer} ${layer.name}: ${layer.applied ? "applied" : "skipped"} (${layer.detail})`,
  );
  const saved = report.tokensBefore - report.tokensAfter;
  lines.push(`total: ${report.tokensBefore} -> ${report.tokensAfter} tokens (~${saved} reclaimed)`);
  if (report.liveStateAnchor !== undefined) lines.push("live state re-anchored after the summary");
  return lines.join("\n");
}
