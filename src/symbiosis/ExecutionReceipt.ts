import type { DagSnapshot } from "../core/PersistentTaskDAG.js";
import type { Checkpoint } from "../security/ShadowGit.js";
import type { CompactionReport } from "../core/CompactionPipeline.js";
import type { TransactionOutcome } from "../core/TransactionManager.js";

/**
 * The record of what a task actually did.
 *
 * A transcript is not a receipt: it is thousands of lines in which the answer,
 * the evidence and the changes are interleaved. What a human needs at the end is
 * short and checkable — what changed, what was run to prove it, what was rolled
 * back, and what is still open. This collects exactly that, from the objects that
 * own the facts rather than from the model's own summary of itself.
 */

export interface ReceiptTransaction {
  label: string;
  committed: boolean;
  rolledBack: boolean;
  reason?: string;
  verificationCommands: string[];
}

export interface ReceiptInput {
  goal: string;
  /** Final answer the model produced, verbatim. */
  answer: string;
  startedAt: string;
  finishedAt?: string;
  steps: number;
  /** Files the session actually wrote, from the backup manifest. */
  filesWritten: string[];
  transactions?: readonly ReceiptTransaction[];
  /** ShadowGit checkpoints taken, in order. */
  checkpoints?: readonly Checkpoint[];
  /** Task graph state at the end, when a plan ran. */
  dag?: DagSnapshot;
  /** Compaction report, so the human knows context was summarised. */
  compaction?: CompactionReport;
  /** Skills loaded during the session. */
  skillsUsed?: readonly string[];
  /** Skills created or evolved during the session. */
  skillsCreated?: readonly string[];
  /** Operator rules in force at the end. */
  operatorRules?: readonly string[];
  /** Reasons the task could not be finished, if any. */
  blockers?: readonly string[];
}

export interface Receipt {
  goal: string;
  answer: string;
  durationMs: number;
  steps: number;
  filesWritten: string[];
  verified: string[];
  rolledBack: string[];
  checkpoints: number;
  plan?: { completed: number; total: number; blocked: boolean };
  compacted: boolean;
  skillsUsed: string[];
  skillsCreated: string[];
  operatorRules: string[];
  blockers: string[];
  /** True when something was verified and nothing was rolled back. */
  clean: boolean;
}

export class ExecutionReceipt {
  /**
   * Builds the structured receipt. Every field is optional in the input because a
   * short task legitimately has no plan, no checkpoints and no transactions; the
   * receipt then says so rather than inventing sections.
   */
  static build(input: ReceiptInput): Receipt {
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    const started = Date.parse(input.startedAt);
    const finished = Date.parse(finishedAt);
    const durationMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;

    const transactions = input.transactions ?? [];
    const verified = transactions.flatMap((transaction) => transaction.verificationCommands);
    const rolledBack = transactions.filter((transaction) => transaction.rolledBack).map((transaction) => transaction.label);

    return {
      goal: input.goal,
      answer: input.answer,
      durationMs,
      steps: input.steps,
      filesWritten: [...new Set(input.filesWritten)].sort(),
      verified: [...new Set(verified)],
      rolledBack,
      checkpoints: input.checkpoints?.length ?? 0,
      ...(input.dag !== undefined
        ? { plan: { completed: input.dag.completed, total: input.dag.nodes.length, blocked: input.dag.failed > 0 } }
        : {}),
      compacted: input.compaction !== undefined && input.compaction.layers.some((layer) => layer.applied && layer.layer === 5),
      skillsUsed: [...(input.skillsUsed ?? [])],
      skillsCreated: [...(input.skillsCreated ?? [])],
      operatorRules: [...(input.operatorRules ?? [])],
      blockers: [...(input.blockers ?? [])],
      clean: rolledBack.length === 0,
    };
  }

  /**
   * Renders the receipt for the terminal.
   *
   * Sections with nothing in them are omitted entirely: a receipt that prints
   * "Rolled back: none" for every trivial task trains the reader to ignore it.
   */
  static format(receipt: Receipt): string {
    const lines: string[] = [];
    const seconds = Math.round(receipt.durationMs / 1000);
    lines.push(`Task: ${receipt.goal.split("\n")[0]}`);
    lines.push(`Duration: ${seconds}s · steps: ${receipt.steps}`);

    if (receipt.filesWritten.length > 0) {
      lines.push(`Files written (${receipt.filesWritten.length}):`);
      for (const file of receipt.filesWritten.slice(0, 20)) lines.push(`  ${file}`);
      if (receipt.filesWritten.length > 20) lines.push(`  … and ${receipt.filesWritten.length - 20} more`);
    } else {
      lines.push("Files written: none");
    }

    if (receipt.verified.length > 0) {
      lines.push(`Verified with: ${receipt.verified.join(", ")}`);
    } else {
      lines.push("Verified with: nothing was run to verify this change");
    }

    if (receipt.rolledBack.length > 0) {
      lines.push(`Rolled back (${receipt.rolledBack.length}): ${receipt.rolledBack.join(", ")}`);
    }

    if (receipt.checkpoints > 0) lines.push(`Checkpoints: ${receipt.checkpoints} (restore with /rewind <id>)`);
    if (receipt.plan !== undefined) {
      lines.push(`Plan: ${receipt.plan.completed}/${receipt.plan.total} nodes completed${receipt.plan.blocked ? " (a node is failed)" : ""}`);
    }
    if (receipt.compacted) lines.push("Context: compacted during the task (live state was re-anchored)");
    if (receipt.skillsUsed.length > 0) lines.push(`Skills used: ${receipt.skillsUsed.join(", ")}`);
    if (receipt.skillsCreated.length > 0) lines.push(`Skills created: ${receipt.skillsCreated.join(", ")}`);
    if (receipt.operatorRules.length > 0) lines.push(`Operator rules in force: ${receipt.operatorRules.join(" | ")}`);
    if (receipt.blockers.length > 0) {
      lines.push("Blockers:");
      for (const blocker of receipt.blockers) lines.push(`  ${blocker}`);
    }

    return lines.join("\n");
  }

  /** True when the receipt contains no evidence that the change was verified. */
  static unverified(receipt: Receipt): boolean {
    return receipt.verified.length === 0 && receipt.filesWritten.length > 0;
  }
}
