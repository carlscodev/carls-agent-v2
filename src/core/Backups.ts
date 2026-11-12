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
export class BackupStore {
  private readonly dir: string;
  private readonly manifestPath: string;

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
