import type { Checkpoint } from "../security/ShadowGit.js";
import { LspSessionPool } from "../lsp/SessionPool.js";
import type { Skill } from "../skills/SkillLoader.js";
import type { DagSnapshot } from "./PersistentTaskDAG.js";

/**
 * The facts a compacted conversation must not lose.
 *
 * Compaction replaces the middle of a transcript with a summary, and a summary of
 * a long task is exactly where a model starts inventing: it forgets which node it
 * was on, re-edits a file it already fixed, or asks a question the user answered
 * forty turns ago. A summary is lossy by construction, so the fix is not a better
 * summary — it is re-injecting the state that must be true, from the sources that
 * own it, after the summary.
 *
 * Everything here is read from a live object, never from the transcript, so it
 * cannot drift from reality.
 */

export interface LiveStateSources {
  /** The user's original request, verbatim. */
  goal: string;
  /** Current plan state, or undefined when no long task is running. */
  dag?: DagSnapshot;
  /** Most recent checkpoint, for the "you can go back to here" line. */
  checkpoint?: Checkpoint;
  /** Language-server errors currently outstanding. */
  lsp?: LspSessionPool;
  /** Files the language server should be asked about. */
  lspFiles?: readonly string[];
  /** Skills already loaded this session, so the model does not reload them. */
  loadedSkills?: readonly Skill[];
  /** Operator rules distilled from previous corrections. */
  operatorRules?: readonly string[];
  /** Non-negotiable instructions from the project's AGENTS.md-style memory. */
  projectRules?: string;
}

export interface LiveStateSection {
  heading: string;
  body: string;
}

/**
 * Renders the live state as a compact, stable block.
 *
 * Deliberately plain text with no emoji: it is injected into the model's context,
 * and every token spent on decoration is a token not spent on the task. The
 * headings are fixed so the model learns where to look across compactions.
 */
export async function buildLiveState(sources: LiveStateSources): Promise<string> {
  const sections: LiveStateSection[] = [];

  sections.push({ heading: "Original goal (verbatim, do not reinterpret)", body: sources.goal.trim() });

  if (sources.dag !== undefined) {
    sections.push({ heading: "Task graph", body: formatDag(sources.dag) });
  }

  if (sources.checkpoint !== undefined) {
    sections.push({
      heading: "Last checkpoint",
      body: `${sources.checkpoint.id} (${sources.checkpoint.label}) taken ${sources.checkpoint.at}. Restore the whole tree with /rewind ${sources.checkpoint.id}.`,
    });
  }

  if (sources.lsp !== undefined && sources.lsp.configured && (sources.lspFiles?.length ?? 0) > 0) {
    const verification = await sources.lsp.verify(sources.lspFiles ?? []);
    const body =
      verification.checked === 0
        ? "no file could be checked (no language server answered)"
        : verification.clean
          ? `clean: 0 errors across ${verification.checked} file(s)`
          : `${verification.results.reduce((total, entry) => total + entry.errors, 0)} error(s) outstanding\n${LspSessionPool.formatDiagnostics(verification)}`;
    sections.push({ heading: "Language server", body });
  }

  if ((sources.loadedSkills?.length ?? 0) > 0) {
    const list = (sources.loadedSkills ?? []).map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    sections.push({ heading: "Skills already loaded (do not reload)", body: list });
  }

  if ((sources.operatorRules?.length ?? 0) > 0) {
    sections.push({
      heading: "Operator rules learned earlier (still in force)",
      body: (sources.operatorRules ?? []).map((rule) => `- ${rule}`).join("\n"),
    });
  }

  if (sources.projectRules !== undefined && sources.projectRules.trim().length > 0) {
    sections.push({ heading: "Project rules", body: sources.projectRules.trim() });
  }

  return [
    "[live state — re-injected after compaction, do not summarise away]",
    ...sections.map((section) => `${section.heading}:\n${section.body}`),
  ].join("\n\n");
}

function formatDag(snapshot: DagSnapshot): string {
  const lines = [
    `objective: ${snapshot.objective}`,
    `progress: ${snapshot.completed}/${snapshot.nodes.length} completed, ${snapshot.failed} failed, ${snapshot.pending} pending`,
  ];
  const current = snapshot.nodes.find((node) => node.status === "running" || node.status === "verifying");
  if (current !== undefined) lines.push(`current node: ${current.id} "${current.title}" [${current.status}]`);
  const next = snapshot.nodes.find((node) => node.status === "pending");
  if (next !== undefined) lines.push(`next node: ${next.id} "${next.title}"`);
  for (const node of snapshot.nodes) {
    const attempts = node.retryCount > 0 ? ` (retries: ${node.retryCount})` : "";
    const criteria = node.acceptanceCriteria.length > 0 ? ` — done when: ${node.acceptanceCriteria}` : "";
    lines.push(`- ${node.id} [${node.status}] ${node.title}${attempts}${criteria}`);
  }
  return lines.join("\n");
}
