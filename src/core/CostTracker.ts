/**
 * Per-model USD prices per 1M tokens. Only a few well-known models are listed;
 * unknown models fall back to zero-cost accounting rather than guessing.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
};

export interface CostChildSnapshot {
  label: string;
  cost: CostSnapshot;
}

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  priced: boolean;
  /** Set on a child tracker, so a aggregate can label the breakdown. */
  label?: string;
  /** Per-child breakdown, present on a parent that spawned sub-agents. */
  children?: CostChildSnapshot[];
}

export interface CostTrackerOptions {
  /** Parent that receives this tracker's usage, preserving the aggregate. */
  parent?: CostTracker;
  label?: string;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private model: string;
  private readonly parent?: CostTracker;
  private readonly label?: string;
  private readonly children: CostTracker[] = [];

  constructor(model: string, options: CostTrackerOptions = {}) {
    this.model = model;
    if (options.parent !== undefined) {
      this.parent = options.parent;
      options.parent.children.push(this);
    }
    if (options.label !== undefined) this.label = options.label;
  }

  /** A child tracker whose usage is forwarded to this one, with a label. */
  child(label: string): CostTracker {
    return new CostTracker(this.model, { parent: this, label });
  }

  setModel(model: string): void {
    this.model = model;
  }

  add(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    // A sub-agent's tracker forwards to its parent so the session total stays
    // correct while this tracker keeps its own individual breakdown.
    this.parent?.add(usage);
  }

  /** Share of prompt tokens served from cache, 0 when the provider is silent. */
  cacheHitRatio(): number {
    const prompt = this.inputTokens + this.cacheReadTokens;
    return prompt > 0 ? this.cacheReadTokens / prompt : 0;
  }

  snapshot(): CostSnapshot {
    const price = PRICES[this.model];
    const base = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      ...(this.label !== undefined ? { label: this.label } : {}),
      ...(this.children.length > 0
        ? { children: this.children.map((child) => ({ label: child.label ?? "child", cost: child.snapshot() })) }
        : {}),
    };
    if (!price) {
      return { ...base, usd: 0, priced: false };
    }
    const usd =
      (this.inputTokens / 1_000_000) * price.input +
      (this.outputTokens / 1_000_000) * price.output;
    return { ...base, usd, priced: true };
  }

  format(): string {
    const snapshot = this.snapshot();
    const tokens = `in ${snapshot.inputTokens.toLocaleString()} / out ${snapshot.outputTokens.toLocaleString()} tokens`;
    if (!snapshot.priced) return `${tokens} · free`;
    return `${tokens} · $${snapshot.usd.toFixed(4)}`;
  }

  /**
   * Terse form for the footer, where space is scarce and the model name is
   * already on the line. Empty until the first token is spent, so a fresh
   * session does not carry a `0 / 0` counter around.
   */
  compact(): string {
    const snapshot = this.snapshot();
    if (snapshot.inputTokens === 0 && snapshot.outputTokens === 0) return "";
    const tokens = `↑${compactCount(snapshot.inputTokens)} ↓${compactCount(snapshot.outputTokens)}`;
    if (!snapshot.priced) return tokens;
    return `${tokens} · $${snapshot.usd.toFixed(4)}`;
  }
}

function compactCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`;
}
