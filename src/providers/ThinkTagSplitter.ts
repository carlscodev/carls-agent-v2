/**
 * Splits a stream that interleaves the visible answer with an inline
 * ` thinking`-style scratchpad. Some thinking models (Qwen, GLM, R1 distills)
 * put the reasoning inside `delta.content` instead of a `reasoning_content`
 * field; without this the private scratchpad would leak into the rendered
 * answer. Stateful because a tag can be split across two frames.
 */

export interface ThinkSplit {
  /** Visible answer text, safe to render. */
  text: string;
  /** Scratchpad text, routed to the thinking panel instead of the answer. */
  reasoning: string;
}

const OPEN_TAGS = [" thinking", "<thinking>"] as const;
const CLOSE_TAGS = [" response", "</thinking>"] as const;

/** Longest suffix of `data` that is a proper prefix of one of `tags`. */
function partialSuffix(data: string, tags: readonly string[]): number {
  const limit = Math.min(data.length, Math.max(...tags.map((tag) => tag.length - 1)));
  for (let len = limit; len >= 1; len--) {
    const suffix = data.slice(data.length - len);
    if (tags.some((tag) => tag.length > len && tag.startsWith(suffix))) return len;
  }
  return 0;
}

/** Earliest occurrence of any tag in `data`, or null when none is present. */
function earliestTag(data: string, tags: readonly string[]): { index: number; tag: string } | null {
  let best: { index: number; tag: string } | null = null;
  for (const tag of tags) {
    const index = data.indexOf(tag);
    if (index === -1) continue;
    if (best === null || index < best.index) best = { index, tag };
  }
  return best;
}

export class ThinkTagSplitter {
  private inside = false;
  private carry = "";

  /** Consumes one delta and returns the visible and hidden parts it completes. */
  push(chunk: string): ThinkSplit {
    let data = this.carry + chunk;
    this.carry = "";
    let text = "";
    let reasoning = "";
    for (;;) {
      const tags = this.inside ? CLOSE_TAGS : OPEN_TAGS;
      const hit = earliestTag(data, tags);
      if (hit !== null) {
        if (this.inside) reasoning += data.slice(0, hit.index);
        else text += data.slice(0, hit.index);
        data = data.slice(hit.index + hit.tag.length);
        this.inside = !this.inside;
        continue;
      }
      const hold = partialSuffix(data, tags);
      if (hold > 0) {
        this.carry = data.slice(data.length - hold);
        data = data.slice(0, data.length - hold);
      }
      if (this.inside) reasoning += data;
      else text += data;
      break;
    }
    return { text, reasoning };
  }

  /**
   * Releases a held-back partial tag. Called when the stream ends: a lone `<`
   * at the tail is answer text, not the head of a tag that never arrived.
   */
  flush(): ThinkSplit {
    const data = this.carry;
    this.carry = "";
    if (data.length === 0) return { text: "", reasoning: "" };
    return this.inside ? { text: "", reasoning: data } : { text: data, reasoning: "" };
  }
}

/**
 * Splits a complete string in one pass. Used by the non-streaming path, where
 * the whole answer arrives at once and no state has to survive between calls.
 */
export function splitThinkTags(input: string): ThinkSplit {
  const splitter = new ThinkTagSplitter();
  const head = splitter.push(input);
  const tail = splitter.flush();
  return { text: head.text + tail.text, reasoning: head.reasoning + tail.reasoning };
}
