import type { BackupEntry, BackupStore } from "./Backups.js";
import type { ShadowGit, Checkpoint } from "../security/ShadowGit.js";
import type { LspSessionPool, LspVerification } from "../lsp/SessionPool.js";

/**
 * A transaction around a group of edits.
 *
 * The agent's real risk is not a single bad edit, it is a sequence of them: three
 * files changed, the fourth fails to type-check, and now the tree is in a state
 * that never existed and that no single `/undo` can unwind. This composes the
 * pieces that already exist into one unit:
 *
 *   begin   → snapshot (ShadowGit when the workspace is a repository, the
 *             per-file BackupStore when it is not)
 *   verify  → language-server errors plus the project's own commands
 *   commit  → keep the snapshot as a named checkpoint
 *   rollback→ restore the tree and record the hypothesis that failed
 *
 * Nothing here decides *whether* the work succeeded; the caller supplies the
 * verification commands, because only the project knows what "passing" means.
 */

export interface VerificationCommand {
  /** Shell command to run. */
  command: string;
  /** Kill it after this long. Defaults to the session's bash timeout. */
  timeoutMs?: number;
}

export interface CommandResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface TransactionOptions {
  /** Human label, used for the checkpoint and the receipt. */
  label: string;
  /** Files the change touched; these are what the language server is asked about. */
  files: readonly string[];
  /** Commands that define success, e.g. `npm test`. Empty means "LSP only". */
  commands?: readonly VerificationCommand[];
  /**
   * How many times `work` may be invoked before the transaction gives up and
   * rolls back. Default 1: a repair is the agent's job, not this class's, so a
   * caller opts into retries only when its `work` is idempotent.
   */
  maxAttempts?: number;
  /** Skip the language-server pass (no server configured, or a non-code change). */
  skipLsp?: boolean;
}

export interface VerificationOutcome {
  clean: boolean;
  /** Empty when the language server was skipped or not configured. */
  lsp?: LspVerification;
  commands: CommandResult[];
  /** One line per reason it is not clean, for the model and the receipt. */
  problems: string[];
}

export interface TransactionOutcome {
  committed: boolean;
  rolledBack: boolean;
  /** "shadow-git" when a checkpoint was taken, "backups" for the fallback. */
  snapshot: "shadow-git" | "backups" | "none";
  checkpoint?: Checkpoint;
  verification?: VerificationOutcome;
  /** The hypothesis the transaction disproved, kept so the model does not retry it. */
  failedHypothesis?: string;
  reason?: string;
}

export interface TransactionManagerDeps {
  shadowGit: ShadowGit;
  backups: BackupStore;
  lsp: LspSessionPool;
  /** Runs one verification command; injected so this stays testable. */
  runCommand: (command: string, timeoutMs: number | undefined) => Promise<CommandResult>;
  /** Default timeout passed to `runCommand` when a command does not set one. */
  defaultTimeoutMs: number;
  /** Called when a transaction rolls back, so the UI can say so. */
  onRollback?: (outcome: TransactionOutcome) => void;
}

export class TransactionManager {
  private readonly deps: TransactionManagerDeps;

  constructor(deps: TransactionManagerDeps) {
    this.deps = deps;
  }

  /**
   * Runs the verification half of a transaction: language server first, because
   * it is fast and local, then the project's own commands.
   */
  async verify(options: TransactionOptions): Promise<VerificationOutcome> {
    const problems: string[] = [];
    let lsp: LspVerification | undefined;

    if (options.skipLsp !== true && this.deps.lsp.configured && options.files.length > 0) {
      lsp = await this.deps.lsp.verify(options.files);
      for (const entry of lsp.results) {
        if (entry.errors === 0) continue;
        problems.push(`${entry.path}: ${entry.errors} error(s) from the language server`);
      }
      // A server that will not start is reported but does not fail the change:
      // a project without the configured server must still be verifiable.
      for (const entry of lsp.unavailable) {
        problems.push(`[unavailable] ${entry.key}: ${entry.reason}`);
      }
    }

    const commands: CommandResult[] = [];
    for (const verification of options.commands ?? []) {
      const result = await this.deps.runCommand(verification.command, verification.timeoutMs ?? this.deps.defaultTimeoutMs);
      commands.push(result);
      if (!result.ok) problems.push(`${verification.command} failed`);
    }

    // An unavailable server is informational, not a failure; an actual diagnostic
    // is. The distinction is what keeps verification useful on a machine with no
    // language server installed.
    const realProblems = problems.filter((problem) => !problem.startsWith("[unavailable]"));
    return { clean: realProblems.length === 0, ...(lsp !== undefined ? { lsp } : {}), commands, problems };
  }

  /**
   * Snapshots the tree before a change.
   *
   * Both paths are best effort and neither throws: a workspace that cannot be
   * snapshotted should still be editable, it just loses the automatic rollback.
   */
  begin(label: string, files: readonly string[]): { snapshot: TransactionOutcome["snapshot"]; checkpoint?: Checkpoint; entries: BackupEntry[] } {
    if (this.deps.shadowGit.enabled) {
      const checkpoint = this.deps.shadowGit.create(label);
      if (checkpoint !== undefined) return { snapshot: "shadow-git", checkpoint, entries: [] };
    }

    // No repository: the per-file store is the only safety net, so every file the
    // change may touch is copied before it is touched.
    const entries: BackupEntry[] = [];
    for (const file of files) {
      const entry = this.deps.backups.save(file);
      if (entry !== undefined) entries.push(entry);
    }
    return { snapshot: entries.length > 0 ? "backups" : "none", entries };
  }

  /**
   * Rolls a transaction back to the state its snapshot captured.
   *
   * Returns true when the tree was restored. A rollback that itself fails is
   * reported rather than swallowed, because that is the one case the human has to
   * hear about.
   */
  rollback(
    snapshot: { snapshot: TransactionOutcome["snapshot"]; checkpoint?: Checkpoint; entries: BackupEntry[] },
  ): { rolledBack: boolean; detail: string } {
    if (snapshot.snapshot === "shadow-git" && snapshot.checkpoint !== undefined) {
      try {
        const result = this.deps.shadowGit.rewind(snapshot.checkpoint);
        const removed = result.deleted.length > 0 ? `, removed ${result.deleted.length} added file(s)` : "";
        return { rolledBack: true, detail: `restored ${result.restored} file(s) from checkpoint ${snapshot.checkpoint.id}${removed}` };
      } catch (error) {
        return { rolledBack: false, detail: `checkpoint rollback failed: ${(error as Error).message}` };
      }
    }

    if (snapshot.entries.length === 0) {
      return { rolledBack: false, detail: "there was no snapshot to roll back to" };
    }

    const messages: string[] = [];
    let failed = 0;
    // Reverse order: the newest copy of a file is the state immediately before the
    // last edit, which is what undoing a sequence has to apply first.
    for (const entry of [...snapshot.entries].reverse()) {
      let message: string;
      try {
        message = this.deps.backups.restore(entry);
      } catch (error) {
        // One file that cannot be restored must not abort the rest of the batch:
        // the operator wants the whole tree back, and a partial restore reported
        // honestly is better than a throw that hides the entries already done.
        message = `FAILED: ${entry.path}: ${(error as Error).message}`;
      }
      if (message.startsWith("FAILED:")) failed++;
      messages.push(message);
    }
    if (failed > 0) {
      return {
        rolledBack: false,
        detail: `${failed} of ${snapshot.entries.length} file(s) could not be restored: ${messages.join("; ")}`,
      };
    }
    return { rolledBack: true, detail: messages.join("; ") };
  }

  /**
   * Runs a change as a transaction: snapshot, let `work` apply it, verify, and
   * roll back if verification fails.
   *
   * `work` may be attempted more than once when `options.maxAttempts` allows it,
   * but this method never invents a repair: it calls `work` again only if the
   * caller's function is idempotent by contract, and otherwise rolls back on the
   * first failure. The autonomous repair loop lives in the agent, which can read
   * the returned problems and try a different approach.
   */
  async run(
    options: TransactionOptions,
    work: (attempt: number) => Promise<void>,
  ): Promise<TransactionOutcome> {
    const files = [...options.files];
    const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    const snapshot = this.begin(options.label, files);

    let verification: VerificationOutcome | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await work(attempt);
      } catch (error) {
        const rolled = this.rollback(snapshot);
        const outcome: TransactionOutcome = {
          committed: false,
          rolledBack: rolled.rolledBack,
          snapshot: snapshot.snapshot,
          ...(snapshot.checkpoint !== undefined ? { checkpoint: snapshot.checkpoint } : {}),
          reason: `the change failed before verification: ${(error as Error).message}`,
          failedHypothesis: options.label,
        };
        this.deps.onRollback?.(outcome);
        return outcome;
      }

      verification = await this.verify(options);
      if (verification.clean) {
        return {
          committed: true,
          rolledBack: false,
          snapshot: snapshot.snapshot,
          ...(snapshot.checkpoint !== undefined ? { checkpoint: snapshot.checkpoint } : {}),
          verification,
        };
      }

      // Verification failed with another attempt still allowed. Restore the
      // baseline first, so the retry starts from the snapshot instead of stacking
      // a second edit on top of the state that just failed.
      if (attempt < maxAttempts) this.rollback(snapshot);
    }

    const rolled = this.rollback(snapshot);
    const outcome: TransactionOutcome = {
      committed: false,
      rolledBack: rolled.rolledBack,
      snapshot: snapshot.snapshot,
      ...(snapshot.checkpoint !== undefined ? { checkpoint: snapshot.checkpoint } : {}),
      ...(verification !== undefined ? { verification } : {}),
      reason: `verification failed: ${verification?.problems.join("; ") ?? "unknown"}. Rollback: ${rolled.detail}`,
      failedHypothesis: options.label,
    };
    this.deps.onRollback?.(outcome);
    return outcome;
  }
}
