import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toLf } from "../utils/eol.js";

/**
 * Whole-workspace checkpoints, stored as git commits under a private ref.
 *
 * `/undo` reverts one file from the backup manifest; that is precise but it only
 * covers files a carls tool wrote, and it cannot answer "put the tree back the
 * way it was five minutes ago". A checkpoint can, which is what a long
 * refactoring needs.
 *
 * Three properties make this safe to run inside someone's repository:
 *
 * 1. It never touches the user's index. Every command runs with its own
 *    `GIT_INDEX_FILE`, so a checkpoint cannot stage, unstage or otherwise disturb
 *    what the developer had staged.
 * 2. It never touches the user's HEAD or working branch. Checkpoints are commits
 *    on `refs/carls/checkpoints/*`, which no branch points at and which a normal
 *    `git log` will not show.
 * 3. It is additive. Untracked files are captured (subject to `.gitignore`), and
 *    nothing is ever deleted from the user's tree by `create`.
 *
 * `rewind` is the destructive half and is therefore explicit: it restores tracked
 * files to the checkpoint's tree and reports what it did.
 */

export interface Checkpoint {
  /** Short id used by `/rewind`. */
  id: string;
  ref: string;
  /** Full commit hash of the checkpoint tree. */
  commit: string;
  label: string;
  at: string;
  /** Files captured, for the confirmation line. */
  files: number;
}

export interface ShadowGitOptions {
  /** Identity used for checkpoint commits; never the user's git config. */
  authorName?: string;
  authorEmail?: string;
}

export class ShadowGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowGitError";
  }
}

const REF_PREFIX = "refs/carls/checkpoints";

export class ShadowGit {
  private readonly cwd: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly indexPath: string;
  private readonly available: boolean;

  constructor(cwd: string, options: ShadowGitOptions = {}) {
    this.cwd = cwd;
    this.authorName = options.authorName ?? "carls-code";
    this.authorEmail = options.authorEmail ?? "carls-code@localhost";
    // A file, not a directory: git creates it. Kept out of the workspace so it
    // cannot show up in a glob or a `git status`.
    this.indexPath = join(tmpdir(), `carls-shadow-${process.pid}-${Date.now()}.index`);
    this.available = this.detect();
  }

  /** True when the workspace is a git repository and git is on PATH. */
  get enabled(): boolean {
    return this.available;
  }

  private detect(): boolean {
    try {
      this.git(["rev-parse", "--git-dir"], { quiet: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs git with the private index and a fixed identity.
   *
   * `commit-tree` refuses to run without an author, and the user's config may
   * have none, so the identity is injected through the environment rather than
   * by writing to their config.
   */
  private git(args: string[], options: { quiet?: boolean; input?: string } = {}): string {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        encoding: "utf8",
        input: options.input,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_INDEX_FILE: this.indexPath,
          GIT_AUTHOR_NAME: this.authorName,
          GIT_AUTHOR_EMAIL: this.authorEmail,
          GIT_COMMITTER_NAME: this.authorName,
          GIT_COMMITTER_EMAIL: this.authorEmail,
          // Keep the output machine-readable and independent of the user's locale.
          LC_ALL: "C",
        },
        stdio: ["pipe", "pipe", options.quiet === true ? "ignore" : "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new ShadowGitError(stderr.trim() || (error as Error).message);
    }
  }

  /**
   * Snapshots the working tree, including untracked files, into a new commit.
   * Returns `undefined` when there is nothing to snapshot or the workspace is not
   * a repository, so a caller can treat it as a best-effort no-op.
   */
  create(label: string): Checkpoint | undefined {
    if (!this.available) return undefined;

    try {
      // `add -A` honours .gitignore, so ignored build output is not captured.
      this.git(["add", "-A", "--", "."]);
      const tree = this.git(["write-tree"]).trim();
      if (tree.length === 0) return undefined;

      const files = this.treeFileCount(tree);
      const now = new Date().toISOString();
      const message = `carls checkpoint: ${label}\n\nCreated ${now}`;

      // Parent on the previous checkpoint when there is one, so the history of a
      // session is a chain rather than a pile of orphans.
      const parents: string[] = [];
      const previous = this.latestCommit();
      if (previous !== undefined) parents.push(previous);

      const parentArgs = parents.flatMap((parent) => ["-p", parent]);
      const commit = this.git(["commit-tree", tree, ...parentArgs, "-m", message]).trim();

      const id = commit.slice(0, 8);
      this.git(["update-ref", `${REF_PREFIX}/${id}`, commit]);

      return { id, ref: `${REF_PREFIX}/${id}`, commit, label, at: now, files };
    } catch (error) {
      if (error instanceof ShadowGitError) return undefined;
      return undefined;
    }
  }

  /** Number of entries in a tree, used only for the confirmation message. */
  private treeFileCount(tree: string): number {
    try {
      const listing = this.git(["ls-tree", "-r", "--name-only", tree]);
      return listing.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  private latestCommit(): string | undefined {
    const list = this.list();
    return list[list.length - 1]?.commit;
  }

  /** All checkpoints, oldest first. */
  list(): Checkpoint[] {
    if (!this.available) return [];
    try {
      const output = this.git([
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(objectname)\t%(refname)",
        REF_PREFIX,
      ]);
      const checkpoints: Checkpoint[] = [];
      for (const line of output.split("\n")) {
        const [commit, ref] = line.split("\t");
        if (commit === undefined || ref === undefined) continue;
        const id = ref.split("/").pop() ?? commit.slice(0, 8);
        const label = this.commitSubject(commit);
        checkpoints.push({
          id,
          ref,
          commit,
          label,
          at: this.commitDate(commit),
          files: 0,
        });
      }
      return checkpoints;
    } catch {
      return [];
    }
  }

  private commitSubject(commit: string): string {
    try {
      const subject = this.git(["log", "-1", "--format=%s", commit]).trim();
      return subject.replace(/^carls checkpoint:\s*/, "");
    } catch {
      return "(unknown)";
    }
  }

  private commitDate(commit: string): string {
    try {
      return this.git(["log", "-1", "--format=%cI", commit]).trim();
    } catch {
      return "";
    }
  }

  /** Resolves a short id, a full hash or a ref to a checkpoint. */
  resolve(idOrRef: string): Checkpoint | undefined {
    const checkpoints = this.list();
    if (idOrRef.length === 0) return checkpoints[checkpoints.length - 1];
    return (
      checkpoints.find((checkpoint) => checkpoint.id === idOrRef) ??
      checkpoints.find((checkpoint) => checkpoint.commit.startsWith(idOrRef)) ??
      checkpoints.find((checkpoint) => checkpoint.ref === idOrRef)
    );
  }

  /**
   * Restores every file in the checkpoint's tree and deletes files that the
   * checkpoint does not contain but the working tree does.
   *
   * A checkpoint taken by `create` always includes untracked files, so restoring
   * one is a faithful "go back to that moment". Files ignored by `.gitignore` are
   * never in the tree and are therefore never deleted.
   */
  rewind(checkpoint: Checkpoint): { restored: number; deleted: string[] } {
    if (!this.available) throw new ShadowGitError("The workspace is not a git repository.");

    // Capture the working tree into the private index *before* it is repointed at
    // the checkpoint, so the set of files that exist now can be compared with the
    // set the checkpoint holds.
    this.git(["add", "-A", "--", "."]);
    const presentNow = this.git(["ls-files"]).split("\n").filter((line) => line.trim().length > 0);

    // `checkout-index -a -f` overwrites working files from the index without
    // touching HEAD or the user's branch.
    this.git(["read-tree", checkpoint.commit]);
    this.git(["checkout-index", "-a", "-f"]);

    const inCheckpoint = new Set(
      this.git(["ls-tree", "-r", "--name-only", checkpoint.commit])
        .split("\n")
        .filter((line) => line.trim().length > 0),
    );

    // A file that existed at rewind time but not in the checkpoint is removed, so
    // the tree matches the snapshot exactly. Ignored files are absent from both
    // sets and are therefore never touched.
    const deleted: string[] = [];
    for (const file of presentNow) {
      if (inCheckpoint.has(file)) continue;
      const absolute = join(this.cwd, file);
      if (!existsSync(absolute)) continue;
      try {
        rmSync(absolute, { force: true });
        deleted.push(file);
      } catch {
        // Best effort: a file that cannot be removed is reported by omission.
      }
    }

    return { restored: inCheckpoint.size, deleted };
  }

  /** Unified diff between a checkpoint and the working tree. */
  diff(checkpoint: Checkpoint): string {
    if (!this.available) throw new ShadowGitError("The workspace is not a git repository.");
    try {
      // `--no-index` is not used: the checkpoint tree is compared against the
      // working tree through the private index, so `git diff` sees both sides.
      this.git(["read-tree", checkpoint.commit]);
      this.git(["add", "-A", "--", "."]);
      const output = this.git(["diff", "--cached", checkpoint.commit]);
      return toLf(output).trimEnd();
    } catch (error) {
      throw new ShadowGitError((error as Error).message);
    }
  }

  /** Drops a checkpoint ref. Returns true when one was removed. */
  remove(idOrRef: string): boolean {
    const checkpoint = this.resolve(idOrRef);
    if (checkpoint === undefined) return false;
    try {
      this.git(["update-ref", "-d", checkpoint.ref]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes the private index file. Called on session end; leaving it behind
   * would accumulate one small file per process in the temp directory.
   */
  dispose(): void {
    try {
      if (existsSync(this.indexPath)) rmSync(this.indexPath, { force: true });
    } catch {
      // Nothing to do: the OS will clean the temp directory.
    }
  }
}
