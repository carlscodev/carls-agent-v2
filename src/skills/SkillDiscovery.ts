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
}

export function discoverSkillsForGoal(
  registry: SkillRegistry,
  goal: string,
  options: SkillDiscoveryOptions = {},
): SkillDiscoveryResult {
  const limit = Math.max(1, options.limit ?? 2);
  const minScore = options.minScore ?? 3;
  const bodyChars = Math.max(200, options.bodyChars ?? 1200);
  const relevant = registry
    .search(goal, Math.max(limit, 8))
    .filter((hit) => hit.score >= minScore)
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
