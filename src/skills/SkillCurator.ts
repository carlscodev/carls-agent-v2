import { existsSync, readFileSync } from "node:fs";
import type { Skill } from "./SkillLoader.js";
import { SkillGraph, SkillHistory } from "./SkillEvolution.js";

/**
 * Decides which skills are worth rewriting, and refuses to write a bad one.
 *
 * An agent that can edit its own skills needs a brake more than it needs an
 * accelerator. Left alone, "improve this skill" degenerates into padding the body
 * with restated instructions, and the cost is invisible until every future session
 * carries a bloated prompt. The curator's rules are therefore mostly about what
 * *not* to accept.
 */

export interface CurationCandidate {
  name: string;
  reason: string;
  /** Higher is more urgent; used to order the review queue. */
  priority: number;
}

export interface SkillProposal {
  name: string;
  description: string;
  body: string;
  whenToUse?: string;
  tags?: string[];
  requires?: string[];
  /** Why this change is an improvement, recorded in the history. */
  note: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  /** A warning does not block the write; an error does. */
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** A skill body longer than this is almost always padded rather than useful. */
const MAX_BODY_CHARS = 12_000;
const MIN_BODY_CHARS = 40;
const MAX_DESCRIPTION_CHARS = 200;

export class SkillCurator {
  private readonly graph: SkillGraph;
  private readonly history: SkillHistory;

  constructor(graph: SkillGraph, history: SkillHistory) {
    this.graph = graph;
    this.history = history;
  }

  /**
   * The review queue, ordered by how much the skill is hurting.
   *
   * Three signals, in order of how badly they mislead the model:
   *  - flagged: the model itself reported the skill was wrong;
   *  - a dependency was rewritten underneath it, so its steps may no longer hold;
   *  - never used, which is dead weight in the skill index.
   */
  candidates(skills: readonly Skill[], usage: (name: string) => { uses: number; needsWork?: boolean } | undefined): CurationCandidate[] {
    const candidates: CurationCandidate[] = [];

    for (const skill of skills) {
      const record = usage(skill.name);

      if (record?.needsWork === true) {
        candidates.push({ name: skill.name, reason: "flagged as wrong or incomplete when last used", priority: 100 });
        continue;
      }

      const stale = this.graph
        .dependencies(skill.name)
        .filter((edge) => edge.kind === "requires" || edge.kind === "extends")
        .filter((edge) => {
          const target = skills.find((candidate) => candidate.name === edge.to);
          if (target === undefined) return false;
          const targetHistory = this.history.latest(target.name);
          const ownHistory = this.history.latest(skill.name);
          // The dependency changed after this skill was last written.
          return targetHistory !== undefined && (ownHistory === undefined || targetHistory.at > ownHistory.at);
        });
      if (stale.length > 0) {
        candidates.push({
          name: skill.name,
          reason: `depends on ${stale.map((edge) => edge.to).join(", ")}, which was revised more recently`,
          priority: 60,
        });
        continue;
      }

      if (record === undefined || record.uses === 0) {
        candidates.push({ name: skill.name, reason: "never used since it was added", priority: 20 });
      }
    }

    return candidates.sort((left, right) => right.priority - left.priority);
  }

  /**
   * Validates a proposal before it is written.
   *
   * Errors are the things that make a skill unusable or dangerous: an empty body,
   * a name that would shadow an unrelated skill, a `requires` on a skill that does
   * not exist, a cycle. Warnings are style, and are surfaced without blocking.
   */
  validate(proposal: SkillProposal, existing: readonly Skill[], replacing = false): ValidationResult {
    const issues: ValidationIssue[] = [];
    const body = proposal.body.trim();

    if (body.length === 0) {
      issues.push({ field: "body", message: "the skill body is empty", severity: "error" });
    } else if (body.length < MIN_BODY_CHARS) {
      issues.push({ field: "body", message: `the body is only ${body.length} characters, too short to be a procedure`, severity: "warning" });
    }
    if (body.length > MAX_BODY_CHARS) {
      issues.push({
        field: "body",
        message: `the body is ${body.length} characters; past ${MAX_BODY_CHARS} a skill is usually padded, move detail into a referenced file`,
        severity: "warning",
      });
    }

    if (!/^[a-z0-9][a-z0-9-]*$/.test(proposal.name)) {
      issues.push({ field: "name", message: "the name must be lower-case words separated by hyphens", severity: "error" });
    }
    if (proposal.description.trim().length === 0) {
      issues.push({ field: "description", message: "a description is required: it is what the model sees in the index", severity: "error" });
    } else if (proposal.description.length > MAX_DESCRIPTION_CHARS) {
      issues.push({ field: "description", message: `the description is ${proposal.description.length} characters; the index only reads about ${MAX_DESCRIPTION_CHARS}`, severity: "warning" });
    }

    const names = new Set(existing.map((skill) => skill.name));
    if (!replacing && names.has(proposal.name)) {
      issues.push({
        field: "name",
        message: `"${proposal.name}" already exists; pass replace: true to revise it, or choose another name`,
        severity: "error",
      });
    }

    for (const requirement of proposal.requires ?? []) {
      if (!names.has(requirement)) {
        issues.push({ field: "requires", message: `"${requirement}" is not a known skill`, severity: "error" });
      }
      if (requirement === proposal.name) {
        issues.push({ field: "requires", message: "a skill cannot require itself", severity: "error" });
      }
    }

    // A body that just restates the description adds nothing and costs context.
    if (body.length > 0 && body.length < 400 && normalise(body) === normalise(proposal.description)) {
      issues.push({ field: "body", message: "the body only repeats the description", severity: "warning" });
    }

    return { ok: !issues.some((issue) => issue.severity === "error"), issues };
  }

  /**
   * Rejects a rewrite that is longer without being more specific.
   *
   * The failure mode this prevents is the common one: a model asked to improve a
   * skill adds caveats and restatements, the body grows, and quality goes down
   * while the token cost goes up. Growth is allowed only when it brings new
   * structure — steps, commands, or checks that were not there before.
   */
  compareRewrite(name: string, nextBody: string): { acceptable: boolean; reason: string } {
    const latest = this.history.latest(name);
    if (latest === undefined) return { acceptable: true, reason: "no previous revision to compare against" };

    const before = latest.contents.length;
    const after = nextBody.length;
    if (after <= before) return { acceptable: true, reason: "the rewrite is not longer than the previous revision" };

    const newStructure = countStructure(nextBody) - countStructure(latest.contents);
    if (newStructure > 0) {
      return { acceptable: true, reason: `longer, but adds ${newStructure} new step(s) or check(s)` };
    }
    return {
      acceptable: false,
      reason: `the rewrite is ${after - before} characters longer without adding a step, command or check; shorten it or justify the growth in the note`,
    };
  }

  /** Records a revision, returning the new version number. */
  record(name: string, contents: string, note: string): number {
    return this.history.record(name, contents, note).version;
  }

  /** Reads a skill file's current contents, for a diff or a revert. */
  static readContents(path: string): string | undefined {
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Counts the structural markers that make a body a procedure rather than prose. */
function countStructure(body: string): number {
  const steps = body.split(/\r?\n/).filter((line) => /^\s*(\d+[.)]|[-*])\s+\S/.test(line)).length;
  const commands = (body.match(/`[^`]+`/g) ?? []).length;
  const checks = body.split(/\r?\n/).filter((line) => /\b(verify|check|test|ensure|confirm)\b/i.test(line)).length;
  return steps + Math.floor(commands / 3) + checks;
}
