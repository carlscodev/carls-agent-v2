import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface BackupEntry {
  id: string;
  at: string;
  /** Absolute path of the file as it was before the edit. */
  path: string;
  /** Absolute path of the stored copy. */
  copy: string;
  /** True when the file did not exist before, so undo means delete. */
  created: boolean;
}

/**
 * Keeps a copy of every file the agent is about to overwrite, so `/undo` can
 * put it back. Copies live under ~/.carls/backups/<session>/.
 */
interface RedoEntry {
  path: string;
  /** Saved copy of the file as it was before the revert; empty when absent. */
  copy: string;
  existed: boolean;
}

export class BackupStore {
  private readonly dir: string;
  private readonly manifestPath: string;
  /** Session-scoped: a restart starts with nothing to redo, which is honest. */
  private readonly redoStack: RedoEntry[] = [];

  constructor(sessionId: string, rootDir?: string) {
    const base = rootDir ?? join(homedir(), ".carls", "backups");
    this.dir = join(base, sessionId);
    this.manifestPath = join(this.dir, "manifest.jsonl");
  }

  /** Stores the current contents of `filePath`; returns the entry, if any. */
  save(filePath: string): BackupEntry | undefined {
    const absolute = resolve(filePath);
    const exists = existsSync(absolute);
    if (!exists) {
      const entry: BackupEntry = {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        path: absolute,
        copy: "",
        created: true,
      };
      this.append(entry);
      return entry;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      const copy = join(this.dir, `${Date.now()}-${basename(absolute)}`);
      copyFileSync(absolute, copy);
      const entry: BackupEntry = {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        path: absolute,
        copy,
        created: false,
      };
      this.append(entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  private append(entry: BackupEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.manifestPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
    } catch {
      // Backups are best effort; a failure must never block an edit.
    }
  }

  list(): BackupEntry[] {
    if (!existsSync(this.manifestPath)) return [];
    const entries: BackupEntry[] = [];
    for (const line of readFileSync(this.manifestPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as BackupEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  latest(): BackupEntry | undefined {
    const entries = this.list();
    return entries[entries.length - 1];
  }

  /**
   * Reverts the last `count` edits. Each file is snapshotted before it is
   * reverted, which is what makes `/redo` possible without a second manifest.
   * Returns one human-readable line per file.
   */
  undo(count = 1): string[] {
    const entries = this.list().slice(-Math.max(1, count));
    const messages: string[] = [];
    for (const entry of [...entries].reverse()) {
      const current = this.snapshotForRedo(entry.path);
      if (current !== undefined) this.redoStack.push(current);
      messages.push(this.restore(entry));
    }
    return messages;
  }

  /**
   * Re-applies what the last undo removed. The stack holds the state as it was
   * before each revert, so popping in order replays the edits forwards.
   */
  redo(count = 1): string[] {
    const messages: string[] = [];
    for (let index = 0; index < Math.max(1, count); index++) {
      const entry = this.redoStack.pop();
      if (entry === undefined) break;
      if (!entry.existed) {
        if (!existsSync(entry.path)) {
          messages.push(`${entry.path} was already absent`);
          continue;
        }
        unlinkSync(entry.path);
        messages.push(`removed ${entry.path} again`);
        continue;
      }
      if (!existsSync(entry.copy)) {
        messages.push(`redo snapshot for ${entry.path} is missing`);
        continue;
      }
      copyFileSync(entry.copy, entry.path);
      messages.push(`re-applied ${entry.path}`);
    }
    return messages;
  }

  /** How many undone edits can still be redone. */
  redoDepth(): number {
    return this.redoStack.length;
  }

  private snapshotForRedo(path: string): RedoEntry | undefined {
    if (!existsSync(path)) return { path, copy: "", existed: false };
    try {
      mkdirSync(this.dir, { recursive: true });
      const copy = join(this.dir, `redo-${Date.now()}-${randomUUID().slice(0, 6)}-${basename(path)}`);
      copyFileSync(path, copy);
      return { path, copy, existed: true };
    } catch {
      return undefined;
    }
  }

  /** Restores an entry. Returns a human-readable outcome. */
  restore(entry: BackupEntry): string {
    if (entry.created) {
      if (!existsSync(entry.path)) return `${entry.path} was already absent`;
      unlinkSync(entry.path);
      return `deleted ${entry.path} (it did not exist before the edit)`;
    }
    if (!existsSync(entry.copy)) return `backup for ${entry.path} is missing`;
    copyFileSync(entry.copy, entry.path);
    return `restored ${entry.path}`;
  }
}
