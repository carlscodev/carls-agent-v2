import type { Skill } from "./SkillLoader.js";
import type { SkillRegistry } from "./SkillRegistry.js";

/**
 * Active skill discovery for a turn.
 *
 * The system prompt already lists the whole catalog, but a model under pressure
 * reads the first screen and starts coding. Cross-referencing the operator's goal
 * with the skills' names, tags and when-to-use text and injecting the top
 * procedures turns a passive menu into an active recommendation. The block is
 * bounded (two skills, capped bodies) so it cannot crowd out the task.
 */

export interface SkillDiscoveryHit {
  skill: Skill;
  score: number;
}

export interface SkillDiscoveryResult {
  relevant: SkillDiscoveryHit[];
  /** Markdown block appended to the turn's system prompt; empty when nothing matches. */
  block: string;
}

export interface SkillDiscoveryOptions {
  /** Maximum skills pre-loaded into the turn. The brief asks for the top two. */
  limit?: number;
  /** Minimum search score; filters single incidental word matches. */
  minScore?: number;
  /** Maximum body characters shown per skill. */
  bodyChars?: number;
  /** Domain skill names suggested by IntentRouter, boosted when present in the registry. */
  hints?: readonly string[];
}

export function discoverSkillsForGoal(
  registry: SkillRegistry,
  goal: string,
  options: SkillDiscoveryOptions = {},
): SkillDiscoveryResult {
  const limit = Math.max(1, options.limit ?? 2);
  const minScore = options.minScore ?? 3;
  const bodyChars = Math.max(200, options.bodyChars ?? 1200);
  const byName = new Map<string, SkillDiscoveryHit>();

  for (const hit of registry.search(goal, Math.max(limit, 8))) {
    if (hit.score >= minScore) {
      byName.set(hit.skill.name, hit);
    }
  }

  // Boost router-recommended domain skills so a terse goal ("crea una api") still
  // loads its matching architecture skill even when exact keywords differ.
  if (options.hints !== undefined && options.hints.length > 0) {
    options.hints.forEach((hintName, index) => {
      const skill = registry.get(hintName);
      if (skill === undefined) return;
      const bonus = Math.max(4, 12 - index * 2);
      const existing = byName.get(skill.name);
      byName.set(skill.name, {
        skill,
        score: (existing?.score ?? 0) + bonus,
      });
    });
  }

  const relevant = [...byName.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (relevant.length === 0) return { relevant: [], block: "" };

  const lines = [
    "[Skill auto-discovery] Relevant skills for this request. Load one with use_skill before acting; its procedure overrides generic habits:",
  ];
  for (const hit of relevant) {
    lines.push(`- ${hit.skill.name} (score ${hit.score.toFixed(1)}): ${hit.skill.description}`);
    const body = hit.skill.body.trim();
    if (body.length > 0) {
      const clipped = body.length > bodyChars ? `${body.slice(0, bodyChars).trimEnd()}\n…` : body;
      lines.push(clipped.replace(/\n/g, "\n  "));
    }
  }
  return { relevant, block: lines.join("\n") };
}
