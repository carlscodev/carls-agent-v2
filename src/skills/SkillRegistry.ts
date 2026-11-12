import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillLoader, type Skill } from "./SkillLoader.js";

interface UsageRecord {
  uses: number;
  /** Timestamp (ms) of the last time the skill was read by the model. */
  lastUsed?: number;
  /** Set when the model reported the skill was wrong or incomplete. */
  needsWork?: boolean;
  note?: string;
}

interface UsageFile {
  version: number;
  skills: Record<string, UsageRecord>;
}

/**
 * Holds the discovered skills and a small usage ledger. The ledger is what
 * makes the system self-improving: every time a skill is used it is recorded,
 * and the model can flag one that turned out to be wrong so `/skills review`
 * surfaces it for a rewrite.
 */
export class SkillRegistry {
  skills: Skill[];
  private byName: Map<string, Skill>;
  private readonly cwd: string;
  private readonly usagePath: string;
  private usage: UsageFile;

  constructor(cwd: string, usageDir?: string) {
    this.cwd = cwd;
    this.skills = SkillLoader.discover(cwd);
    this.byName = new Map(this.skills.map((skill) => [skill.name, skill]));
    this.usagePath = join(usageDir ?? join(cwd, ".carls"), "skill-usage.json");
    this.usage = this.loadUsage();
  }

  /** Re-reads skills from disk, so a skill saved mid-session is immediately usable. */
  refresh(): void {
    this.skills = SkillLoader.discover(this.cwd);
    this.byName = new Map(this.skills.map((skill) => [skill.name, skill]));
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  /** Marks a skill as used, feeding the self-improvement ledger. */
  recordUse(name: string): void {
    const entry = this.usage.skills[name] ?? { uses: 0 };
    entry.uses += 1;
    entry.lastUsed = Date.now();
    this.usage.skills[name] = entry;
    this.persist();
  }

  /** The model reports a skill that did not work as written. */
  flag(name: string, note: string): void {
    const entry = this.usage.skills[name] ?? { uses: 0 };
    entry.needsWork = true;
    entry.note = note;
    this.usage.skills[name] = entry;
    this.persist();
  }

  usageFor(name: string): UsageRecord | undefined {
    return this.usage.skills[name];
  }

  /** Skills that a skill flagged as broken, or that have never been used. */
  reviewQueue(): { name: string; reason: string }[] {
    const queue: { name: string; reason: string }[] = [];
    for (const skill of this.skills) {
      const record = this.usage.skills[skill.name];
      if (record?.needsWork === true) {
        queue.push({ name: skill.name, reason: record.note ?? "flagged as incorrect" });
      } else if (record === undefined) {
        queue.push({ name: skill.name, reason: "never used" });
      }
    }
    return queue;
  }

  /**
   * Ranks skills against a query using name, tag and description overlap plus a
   * small recency bonus. Deterministic, so tests are stable.
   */
  search(query: string, limit = 5): { skill: Skill; score: number }[] {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return this.skills.slice(0, limit).map((skill) => ({ skill, score: 0 }));
    }
    const scored = this.skills.map((skill) => {
      const haystack = tokenize(`${skill.name} ${skill.tags.join(" ")} ${skill.description} ${skill.whenToUse ?? ""}`);
      const set = new Set(haystack);
      let score = 0;
      for (const term of terms) {
        if (set.has(term)) score += 3;
        else if (haystack.some((word) => word.startsWith(term) || term.startsWith(word))) score += 1;
      }
      if (set.has(skill.name)) score += 2;
      const record = this.usage.skills[skill.name];
      if (record !== undefined && record.uses > 0) score += 0.5;
      return { skill, score };
    });
    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit);
  }

  private loadUsage(): UsageFile {
    if (!existsSync(this.usagePath)) return { version: 1, skills: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.usagePath, "utf8")) as UsageFile;
      return { version: 1, skills: parsed.skills ?? {} };
    } catch {
      return { version: 1, skills: {} };
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.usagePath, ".."), { recursive: true });
      writeFileSync(this.usagePath, `${JSON.stringify(this.usage, null, 2)}\n`, "utf8");
    } catch {
      // The ledger is a nicety; a read-only workspace must not break a run.
    }
  }
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "in", "on", "how", "do",
  "i", "my", "me", "is", "it", "this", "that", "use", "using", "when", "you", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}
