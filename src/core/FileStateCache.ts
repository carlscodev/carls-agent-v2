import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { windowsPathKey } from "../os/WindowsCompat.js";
import type { SymbolEntry } from "./RepoMap.js";

/**
 * Cached facts about one source file.
 *
 * `mtimeMs` and `size` are the freshness key because they are one `stat` away;
 * `contentHash` is kept for diagnostics (and for callers that need identity
 * without re-reading) but never computed on the hot path.
 */
export interface FileStateEntry {
  /** Workspace-relative, forward-slashed, as the repository map displays it. */
  file: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  symbols: SymbolEntry[];
  imports: string[];
  lines: number;
}

export interface FileStateStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface FileStatLike {
  mtimeMs: number;
  size: number;
}

/** Stable content identity, used to prove a cache hit in tests and receipts. */
export function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function normalize(path: string): string {
  const absolute = resolve(path);
  // Windows paths are case-insensitive, and tools can produce either casing for
  // the same file (including `c:\` vs `C:\` or an MSYS `/c/` path). The shared
  // key canonicalises the drive before lower-casing, so one file is one entry.
  return process.platform === "win32" ? windowsPathKey(absolute) : absolute;
}

/**
 * A bounded LRU cache of parsed file state.
 *
 * The repository map is the expensive consumer: re-extracting symbols for a
 * whole tree costs hundreds of milliseconds, while reusing the previous symbols
 * for an unchanged file costs one `stat`. Writes invalidate explicitly, so a
 * stale entry is never served after the agent edited the file itself.
 */
export class FileStateCache {
  private readonly entries = new Map<string, FileStateEntry>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(16, options.maxEntries ?? 4096);
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): FileStateStats {
    return { size: this.entries.size, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }

  /** Raw lookup without a freshness check. Prefer `lookup` for real reads. */
  get(path: string): FileStateEntry | undefined {
    const key = normalize(path);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Refresh recency: Map preserves insertion order, so delete + set is an LRU
    // bump without a second index.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Returns the cached entry only when the file still has the same mtime and
   * size. A stale entry is dropped so it cannot be revived later.
   */
  lookup(path: string, stat: FileStatLike): FileStateEntry | undefined {
    const entry = this.get(path);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      this.misses++;
      this.entries.delete(normalize(path));
      return undefined;
    }
    this.hits++;
    return entry;
  }

  /** Stores a freshly parsed entry, evicting the least-recently used one. */
  put(path: string, entry: FileStateEntry): void {
    const key = normalize(path);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions++;
    }
  }

  /** Drops one path. Returns true when it was cached. */
  invalidate(path: string): boolean {
    return this.entries.delete(normalize(path));
  }

  /** Drops every cached file under a directory, for multi-file writes. */
  invalidateUnder(dir: string): number {
    const prefix = normalize(dir) + sep;
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key === normalize(dir) || key.startsWith(prefix)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  /** Resets counters but keeps entries; used by `/doctor` style reporting. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

/**
 * Process-wide cache. Tools invalidate it by absolute path; the repository map
 * reads it by the same path, so no context plumbing is required.
 */
export const fileStateCache = new FileStateCache();

/** Test hook: a fresh process-wide cache with no entries or counters. */
export function resetFileStateCache(): void {
  fileStateCache.clear();
  fileStateCache.resetStats();
}
