import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SteeringDecision } from "./SteeringClassifier.js";

/**
 * What the operator has taught this workspace.
 *
 * When a human corrects the agent — "we use tabs here", "never touch the
 * generated directory", "run the type check before the tests" — that correction is
 * usually forgotten the moment the turn ends, and the same mistake is made next
 * week. This stores the lesson, not the sentence: a short rule, its source, and a
 * count of how often it has been confirmed.
 *
 * The rules are re-injected into the live state after a compaction, which is what
 * makes them outlive the transcript they came from.
 */

export interface OperatorRule {
  /** Stable id, derived from the normalised rule text so repeats merge. */
  id: string;
  /** The rule, phrased as an instruction to the agent. */
  text: string;
  /** The operator's words that produced it, kept for context. */
  source: string;
  /** ISO timestamp of the first time it was learned. */
  learnedAt: string;
  /** How many times the operator has repeated this correction. */
  confirmations: number;
  /** "correction" for a fix, "instruction" for a stated preference. */
  kind: "correction" | "instruction";
}

interface MemoryFile {
  version: number;
  rules: OperatorRule[];
}

const MEMORY_VERSION = 1;
/** A rule repeated more than this often is almost certainly a project convention. */
const CONVENTION_THRESHOLD = 3;

export class OperatorCognitiveMemory {
  private readonly path: string;
  private rules: OperatorRule[];

  constructor(stateDir: string) {
    this.path = join(stateDir, "operator-memory.json");
    this.rules = this.load();
  }

  private load(): OperatorRule[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<MemoryFile>;
      if (parsed.version !== MEMORY_VERSION || !Array.isArray(parsed.rules)) return [];
      return parsed.rules as OperatorRule[];
    } catch {
      return [];
    }
  }

  /**
   * Learns from a steering decision.
   *
   * Only corrections and explicit instructions become rules: an approval teaches
   * nothing, and a question is not a preference. The rule text is the operator's
   * own sentence trimmed to its first line, because paraphrasing it is how a
   * convention gets subtly inverted.
   */
  learn(decision: SteeringDecision, message: string): OperatorRule | undefined {
    if (decision.intent !== "correct" && decision.intent !== "steer" && decision.intent !== "reject") return undefined;
    const text = firstSentence(message);
    if (text.length < 8) return undefined;

    const id = slug(text);
    const existing = this.rules.find((rule) => rule.id === id);
    if (existing !== undefined) {
      existing.confirmations += 1;
      this.persist();
      return existing;
    }

    const rule: OperatorRule = {
      id,
      text,
      source: message.trim(),
      learnedAt: new Date().toISOString(),
      confirmations: 1,
      kind: decision.intent === "correct" || decision.intent === "reject" ? "correction" : "instruction",
    };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  /** Adds a rule stated directly, without going through a classifier. */
  addRule(text: string, kind: OperatorRule["kind"] = "instruction"): OperatorRule | undefined {
    const trimmed = firstSentence(text);
    if (trimmed.length < 8) return undefined;
    const id = slug(trimmed);
    const existing = this.rules.find((rule) => rule.id === id);
    if (existing !== undefined) {
      existing.confirmations += 1;
      this.persist();
      return existing;
    }
    const rule: OperatorRule = {
      id,
      text: trimmed,
      source: text.trim(),
      learnedAt: new Date().toISOString(),
      confirmations: 1,
      kind,
    };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  all(): OperatorRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  /**
   * The rules worth injecting into the prompt: confirmed conventions first, then
   * everything else. Capped, because a hundred rules is a prompt nobody reads.
   */
  active(limit = 20): OperatorRule[] {
    return [...this.rules]
      .sort((left, right) => {
        const leftConvention = left.confirmations >= CONVENTION_THRESHOLD ? 1 : 0;
        const rightConvention = right.confirmations >= CONVENTION_THRESHOLD ? 1 : 0;
        if (leftConvention !== rightConvention) return rightConvention - leftConvention;
        return right.confirmations - left.confirmations;
      })
      .slice(0, limit);
  }

  /** Just the rule text, for the live-state block. */
  activeTexts(limit = 20): string[] {
    return this.active(limit).map((rule) => {
      const marker = rule.confirmations >= CONVENTION_THRESHOLD ? ` (confirmed ${rule.confirmations}x)` : "";
      return `${rule.text}${marker}`;
    });
  }

  forget(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    if (this.rules.length === before) return false;
    this.persist();
    return true;
  }

  /** Writes through a temporary file, so a crash cannot truncate the memory. */
  private persist(): void {
    const file: MemoryFile = { version: MEMORY_VERSION, rules: this.rules };
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
    } catch {
      // A read-only workspace must not break the session.
    }
  }
}

/** The first sentence, capped, because a rule is one idea. */
function firstSentence(text: string): string {
  const trimmed = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const firstStop = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  return firstStop.slice(0, 200).trim();
}

/** A stable id from the normalised text, so the same rule merges rather than duplicates. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
