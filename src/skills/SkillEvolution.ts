import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type Skill } from "./SkillLoader.js";

/**
 * Version history for a skill, so a rewrite can be undone.
 *
 * A self-improving system that can only move forward is dangerous: the first bad
 * rewrite of a working skill silently degrades every future session, and there is
 * nothing to compare against. Keeping the previous bodies is what makes "the model
 * improved this skill" a claim that can be checked and reverted.
 */

export interface SkillRevision {
  version: number;
  at: string;
  /** The full file contents at this revision, so a revert is exact. */
  contents: string;
  /** Why this revision was written, shown by `/skills history`. */
  note: string;
  /** Session or actor that produced it. */
  author: string;
}

interface HistoryFile {
  version: number;
  skills: Record<string, SkillRevision[]>;
}

const HISTORY_VERSION = 1;

export class SkillHistory {
  private readonly path: string;
  private data: HistoryFile;

  constructor(stateDir: string) {
    this.path = join(stateDir, "skill-history.json");
    this.data = this.load();
  }

  private load(): HistoryFile {
    if (!existsSync(this.path)) return { version: HISTORY_VERSION, skills: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<HistoryFile>;
      if (parsed.version !== HISTORY_VERSION || typeof parsed.skills !== "object" || parsed.skills === null) {
        return { version: HISTORY_VERSION, skills: {} };
      }
      return { version: HISTORY_VERSION, skills: parsed.skills };
    } catch {
      return { version: HISTORY_VERSION, skills: {} };
    }
  }

  /** Records a revision. Version numbers are per-skill and monotonic. */
  record(name: string, contents: string, note: string, author = "agent"): SkillRevision {
    const revisions = this.data.skills[name] ?? [];
    const nextVersion = (revisions[revisions.length - 1]?.version ?? 0) + 1;
    const revision: SkillRevision = { version: nextVersion, at: new Date().toISOString(), contents, note, author };
    revisions.push(revision);
    this.data.skills[name] = revisions;
    this.persist();
    return revision;
  }

  /** All revisions of a skill, oldest first. */
  revisions(name: string): SkillRevision[] {
    return this.data.skills[name] ?? [];
  }

  /** The revision before the current one, which is what a revert restores. */
  previous(name: string): SkillRevision | undefined {
    const revisions = this.revisions(name);
    return revisions.length >= 2 ? revisions[revisions.length - 2] : undefined;
  }

  latest(name: string): SkillRevision | undefined {
    const revisions = this.revisions(name);
    return revisions[revisions.length - 1];
  }

  /** Every skill that has at least one revision. */
  tracked(): string[] {
    return Object.keys(this.data.skills);
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    } catch {
      // History is best effort; losing it must not block a skill write.
    }
  }
}

export interface SkillEdge {
  from: string;
  to: string;
  /** `requires` means the target must be read first; `extends` means it refines it. */
  kind: "requires" | "extends" | "related";
}

/**
 * The relationships between skills.
 *
 * Skills are not independent: a "migrate an ESM package" skill is useless without
 * the "run the test suite" one it assumes, and a curator that deletes a skill
 * without checking who points at it breaks the set. The graph makes both visible:
 * `/skills graph` shows what depends on what, and `dependents()` answers the
 * question a deletion has to ask first.
 *
 * Edges are declared in a skill's frontmatter (`requires: [other-skill]`), so the
 * graph is derived from the files rather than maintained separately.
 */
export class SkillGraph {
  private readonly edges: SkillEdge[] = [];

  constructor(skills: readonly Skill[]) {
    this.build(skills);
  }

  private build(skills: readonly Skill[]): void {
    const names = new Set(skills.map((skill) => skill.name));
    for (const skill of skills) {
      // The loader keeps unknown frontmatter out of the Skill type, so the raw
      // file is read again for the relationship keys.
      const raw = readFrontmatterLists(skill.path);
      for (const target of raw.requires) {
        if (names.has(target) && target !== skill.name) this.edges.push({ from: skill.name, to: target, kind: "requires" });
      }
      for (const target of raw.extends) {
        if (names.has(target) && target !== skill.name) this.edges.push({ from: skill.name, to: target, kind: "extends" });
      }
      for (const target of raw.related) {
        if (names.has(target) && target !== skill.name) this.edges.push({ from: skill.name, to: target, kind: "related" });
      }
    }
  }

  all(): SkillEdge[] {
    return this.edges;
  }

  /** Skills that point at `name`, which a deletion or rewrite must account for. */
  dependents(name: string): SkillEdge[] {
    return this.edges.filter((edge) => edge.to === name);
  }

  /** Skills `name` points at. */
  dependencies(name: string): SkillEdge[] {
    return this.edges.filter((edge) => edge.from === name);
  }

  /**
   * Skills that must be read before `name`, transitively.
   *
   * Used by `use_skill` to hand the model the prerequisites with the skill, rather
   * than letting it discover the gap halfway through the procedure.
   */
  closure(name: string): string[] {
    const seen = new Set<string>();
    const queue = this.dependencies(name)
      .filter((edge) => edge.kind === "requires" || edge.kind === "extends")
      .map((edge) => edge.to);
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      for (const edge of this.dependencies(next)) {
        if (edge.kind === "requires" || edge.kind === "extends") queue.push(edge.to);
      }
    }
    return [...seen];
  }

  /** Detects a cycle, which would make a requires-closure infinite. */
  cycles(): string[][] {
    const found: string[][] = [];
    const visiting = new Set<string>();
    const stack: string[] = [];
    const done = new Set<string>();

    const visit = (name: string): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        const start = stack.indexOf(name);
        if (start !== -1) found.push([...stack.slice(start), name]);
        return;
      }
      visiting.add(name);
      stack.push(name);
      for (const edge of this.dependencies(name)) visit(edge.to);
      stack.pop();
      visiting.delete(name);
      done.add(name);
    };

    for (const edge of this.edges) visit(edge.from);
    return found;
  }

  /** Mermaid-ish text for `/skills graph`. */
  format(): string {
    if (this.edges.length === 0) return "no declared relationships between skills";
    return this.edges.map((edge) => `${edge.from} --${edge.kind}--> ${edge.to}`).join("\n");
  }
}

/**
 * Reads the three relationship keys from a skill file's frontmatter.
 *
 * The parser lives in `SkillLoader` so the graph and the loader cannot disagree
 * about the syntax; this only pulls the keys the graph needs and tolerates a
 * file that has none.
 */
function readFrontmatterLists(path: string): { requires: string[]; extends: string[]; related: string[] } {
  const empty = { requires: [] as string[], extends: [] as string[], related: [] as string[] };
  try {
    const { data } = parseFrontmatter(readFileSync(path, "utf8"));
    const read = (key: string): string[] => {
      const value = data[key];
      if (!Array.isArray(value)) return [];
      return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
        .filter((entry) => entry.length > 0);
    };
    return { requires: read("requires"), extends: read("extends"), related: read("related") };
  } catch {
    return empty;
  }
}
