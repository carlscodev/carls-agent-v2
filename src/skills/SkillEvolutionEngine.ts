import { homedir } from "node:os";
import { join } from "node:path";
import { SkillLoader, type Skill } from "./SkillLoader.js";
import { SkillGraph, SkillHistory } from "./SkillEvolution.js";
import {
  SkillCurator,
  archiveSkill as disableSkill,
  detectDuplicates as findDuplicateSkills,
  promoteSkill as publishProjectSkill,
  type ArchiveResult,
  type CurationCandidate,
  type DuplicatePair,
  type PromotionResult,
  type SkillProposal,
  type ValidationResult,
} from "./SkillCurator.js";
import type { SkillRegistry } from "./SkillRegistry.js";

/**
 * The facade the tools talk to.
 *
 * It exists so the three parts — the graph, the history and the curator — are
 * always built from the same on-disk state. Constructing them independently in
 * each tool is how a graph goes stale after a write and a curator then approves a
 * rewrite that breaks a dependency it can no longer see.
 */

export interface EvolutionOutcome {
  ok: boolean;
  path?: string;
  version?: number;
  validation: ValidationResult;
  /** Set when the rewrite was rejected by the growth rule. */
  rejected?: string;
}

export class SkillEvolutionEngine {
  private readonly cwd: string;
  private readonly stateDir: string;

  constructor(cwd: string, stateDir?: string) {
    this.cwd = cwd;
    this.stateDir = stateDir ?? join(cwd, ".carls");
  }

  private get history(): SkillHistory {
    return new SkillHistory(this.stateDir);
  }

  /** Skills as they are on disk right now, not as they were at startup. */
  private skills(): Skill[] {
    return SkillLoader.discover(this.cwd);
  }

  graph(): SkillGraph {
    return new SkillGraph(this.skills());
  }

  curator(): SkillCurator {
    return new SkillCurator(this.graph(), this.history);
  }

  /** Ordered list of skills that need attention, for `/skills review`. */
  reviewQueue(registry: SkillRegistry | undefined): CurationCandidate[] {
    const skills = this.skills();
    return this.curator().candidates(skills, (name) => {
      registry?.refresh();
      const usage = registry?.usageFor(name);
      return usage === undefined ? undefined : { uses: usage.uses, needsWork: usage.needsWork === true };
    });
  }

  /**
   * Writes a skill revision.
   *
   * Order matters: validate against the skills on disk, refuse a rewrite that only
   * grew, then write and record. Recording after a successful write means the
   * history never points at a file that was not written.
   */
  evolve(proposal: SkillProposal, registry: SkillRegistry | undefined, replacing: boolean): EvolutionOutcome {
    const skills = this.skills();
    const curator = this.curator();
    const validation = curator.validate(proposal, skills, replacing);
    if (!validation.ok) return { ok: false, validation };

    if (replacing) {
      const comparison = curator.compareRewrite(proposal.name, proposal.body);
      if (!comparison.acceptable) {
        return { ok: false, validation, rejected: comparison.reason };
      }
    }

    const frontmatter = [
      "---",
      `name: ${proposal.name}`,
      `description: ${proposal.description}`,
      ...(proposal.whenToUse !== undefined ? [`when_to_use: ${proposal.whenToUse}`] : []),
      ...((proposal.tags?.length ?? 0) > 0 ? [`tags: [${proposal.tags?.join(", ")}]`] : []),
      ...((proposal.requires?.length ?? 0) > 0 ? [`requires: [${proposal.requires?.join(", ")}]`] : []),
      "---",
      "",
    ].join("\n");
    const contents = `${frontmatter}${proposal.body.trim()}\n`;

    try {
      const path = SkillLoader.write(this.cwd, proposal.name, contents);
      const version = curator.record(proposal.name, contents, proposal.note);
      registry?.refresh();
      return { ok: true, path, version, validation };
    } catch (error) {
      return {
        ok: false,
        validation: { ok: false, issues: [...validation.issues, { field: "file", message: (error as Error).message, severity: "error" }] },
      };
    }
  }

  /**
   * Restores the previous revision of a skill.
   *
   * Refuses when there is nothing to restore to, rather than writing an empty file:
   * a revert that silently blanks a working skill is worse than a failed one.
   */
  revert(name: string, registry: SkillRegistry | undefined): { ok: boolean; version?: number; detail: string } {
    const previous = this.history.previous(name);
    if (previous === undefined) {
      return { ok: false, detail: `"${name}" has no earlier revision to restore` };
    }
    try {
      const path = SkillLoader.write(this.cwd, name, previous.contents);
      // The revert is itself a revision, so it can be undone too.
      const version = this.history.record(name, previous.contents, `reverted to v${previous.version}`, "operator").version;
      registry?.refresh();
      return { ok: true, version, detail: `restored ${path} to revision v${previous.version}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  historyFor(name: string): { version: number; at: string; note: string; author: string; chars: number }[] {
    return this.history.revisions(name).map((revision) => ({
      version: revision.version,
      at: revision.at,
      note: revision.note,
      author: revision.author,
      chars: revision.contents.length,
    }));
  }

  /** Skills whose bodies overlap enough to be consolidated. */
  detectDuplicates(): DuplicatePair[] {
    return findDuplicateSkills(this.skills());
  }

  /** Publishes a proven project skill to the user catalog. */
  promote(name: string, registry: SkillRegistry | undefined): PromotionResult {
    const skill = this.skills().find((candidate) => candidate.name === name);
    if (skill === undefined) return { ok: false, reason: `unknown skill "${name}"` };
    const usage = registry?.usageFor(name);
    const result = publishProjectSkill(
      skill,
      join(homedir(), ".carls", "skills"),
      usage === undefined ? undefined : { uses: usage.uses, needsWork: usage.needsWork },
    );
    if (result.ok) registry?.refresh();
    return result;
  }

  /** Disables a skill reversibly, refusing when an active skill depends on it. */
  archive(name: string, registry: SkillRegistry | undefined): ArchiveResult {
    const skills = this.skills();
    const skill = skills.find((candidate) => candidate.name === name);
    if (skill === undefined) return { ok: false, reason: `unknown skill "${name}"` };
    const result = disableSkill(skill, new SkillGraph(skills));
    if (result.ok) registry?.refresh();
    return result;
  }
}
