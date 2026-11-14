/**
 * Addressable transcript blocks.
 *
 * The full-screen viewport used to be an append-only string buffer: a tool card
 * was printed once at `tool.start`, so a spinner could never become a result.
 * This store gives every block an identity, lets a later event replace it in
 * place, and keeps one expandable/collapsible state per card.
 *
 * Text (assistant deltas, steering lines, notes) lives in a stream block; a card
 * splits the stream so subsequent text lands after the card, not before it.
 */

export type BlockState = "running" | "ok" | "failed" | "static";

export interface BlockRenderContext {
  /** Current spinner glyph, supplied by the animation ticker. */
  spinner: string;
  expanded: boolean;
}

export interface BlockOptions {
  /** Whether Ctrl+O can toggle this card. */
  expandable?: boolean;
  expanded?: boolean;
  state?: BlockState;
}

export interface ToggleResult {
  id: string;
  expanded: boolean;
}

interface TextBlock {
  kind: "text";
  id: string;
  text: string;
}

interface CardBlock {
  kind: "card";
  id: string;
  render: (context: BlockRenderContext) => string[];
  expandable: boolean;
  expanded: boolean;
  state: BlockState;
  updatedAt: number;
}

type Block = TextBlock | CardBlock;

export class TranscriptStore {
  private blocks: Block[] = [];
  private streamId = "stream-0";
  private counter = 0;

  /** Appends raw text to the stream block that follows the last card. */
  appendText(text: string): void {
    if (text.length === 0) return;
    const current = this.blocks.find((block): block is TextBlock => block.kind === "text" && block.id === this.streamId);
    if (current !== undefined) {
      current.text += text;
      return;
    }
    this.blocks.push({ kind: "text", id: this.streamId, text });
  }

  /**
   * Inserts or replaces a card. A new card rotates the stream id so later text
   * is appended after it; replacing an existing card keeps its expanded state
   * unless the caller explicitly sets one.
   */
  putBlock(
    id: string | undefined,
    render: (context: BlockRenderContext) => string[],
    options: BlockOptions = {},
  ): string {
    const blockId = id ?? `block-${++this.counter}`;
    const existing = this.blocks.find((block) => block.id === blockId);
    if (existing?.kind === "card") {
      existing.render = render;
      existing.expandable = options.expandable ?? existing.expandable;
      existing.expanded = options.expanded ?? existing.expanded;
      existing.state = options.state ?? existing.state;
      existing.updatedAt = Date.now();
      return blockId;
    }
    if (existing?.kind === "text") {
      existing.text = "";
    }
    this.blocks.push({
      kind: "card",
      id: blockId,
      render,
      expandable: options.expandable === true,
      expanded: options.expanded === true,
      state: options.state ?? "static",
      updatedAt: Date.now(),
    });
    this.streamId = `stream-${++this.counter}`;
    return blockId;
  }

  /** Toggles a card, or the most recent expandable one when `id` is omitted. */
  toggle(id?: string): ToggleResult | undefined {
    const card =
      id !== undefined
        ? this.blocks.find((block): block is CardBlock => block.kind === "card" && block.id === id)
        : [...this.blocks]
            .reverse()
            .find((block): block is CardBlock => block.kind === "card" && block.expandable);
    if (card === undefined || !card.expandable) return undefined;
    card.expanded = !card.expanded;
    card.updatedAt = Date.now();
    return { id: card.id, expanded: card.expanded };
  }

  /** The current spinner must repaint only while a card is running. */
  hasRunning(): boolean {
    return this.blocks.some((block) => block.kind === "card" && block.state === "running");
  }

  /** Replace a card's state without changing its renderer (used by the sweep). */
  setState(id: string, state: BlockState): void {
    const card = this.blocks.find((block): block is CardBlock => block.kind === "card" && block.id === id);
    if (card === undefined) return;
    card.state = state;
    card.updatedAt = Date.now();
  }

  /**
   * Turn-end sweep. Every card still marked running is replaced by `renderFor`
   * and marked failed, so no `⠋` can survive into the next prompt.
   */
  finalizeRunning(
    renderFor: (id: string) => (context: BlockRenderContext) => string[],
  ): number {
    let count = 0;
    for (const block of this.blocks) {
      if (block.kind !== "card" || block.state !== "running") continue;
      block.render = renderFor(block.id);
      block.state = "failed";
      block.updatedAt = Date.now();
      count++;
    }
    return count;
  }

  /** Complete rendered stream, in block order. */
  render(spinner: string): string[] {
    const out: string[] = [];
    for (const block of this.blocks) {
      const lines =
        block.kind === "text"
          ? block.text.replace(/\r\n/g, "\n").split("\n")
          : block.render({ spinner, expanded: block.expanded });
      // Drop the synthetic trailing empty line a text block gets from a terminal
      // newline; the separation below is the one that belongs in the transcript.
      if (block.kind === "text" && lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) continue;
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(...lines);
    }
    return out;
  }

  clear(): void {
    this.blocks = [];
    this.streamId = "stream-0";
    this.counter = 0;
  }

  size(): number {
    return this.blocks.length;
  }
}
