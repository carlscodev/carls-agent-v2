import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../types/llm.js";

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model: string;
}

export interface SessionIndexEntry extends SessionMeta {
  path: string;
}

interface SessionRecord {
  type: "meta" | "message" | "checkpoint";
  payload: unknown;
}

/**
 * Append-only JSONL session log under ~/.carls/sessions. Each message is one
 * line, so a crash mid-session loses at most the last turn. `--resume` reads
 * the log back and rebuilds the in-memory history.
 */
export class SessionStore {
  readonly id: string;
  readonly path: string;
  private meta: SessionMeta;

  constructor(cwd: string, model: string, id?: string, rootDir?: string) {
    const base = rootDir ?? join(homedir(), ".carls", "sessions");
    mkdirSync(base, { recursive: true });
    this.id = id ?? SessionStore.newId();
    this.path = join(base, `${this.id}.jsonl`);
    const now = new Date().toISOString();
    this.meta = { id: this.id, cwd, createdAt: now, updatedAt: now, model };
    if (!existsSync(this.path)) {
      this.append({ type: "meta", payload: this.meta });
    }
  }

  static newId(): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const random = Math.random().toString(36).slice(2, 6);
    return `${stamp}-${random}`;
  }

  static baseDir(rootDir?: string): string {
    return rootDir ?? join(homedir(), ".carls", "sessions");
  }

  static list(rootDir?: string): SessionIndexEntry[] {
    const base = SessionStore.baseDir(rootDir);
    if (!existsSync(base)) return [];
    const entries: SessionIndexEntry[] = [];
    for (const file of readdirSync(base)) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(base, file);
      try {
        const first = readFileSync(full, "utf8").split("\n", 1)[0] ?? "";
        const record = JSON.parse(first) as SessionRecord;
        if (record.type === "meta") {
          entries.push({ ...(record.payload as SessionMeta), path: full });
        }
      } catch {
        continue;
      }
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return entries;
  }

  static latestForCwd(cwd: string, rootDir?: string): SessionIndexEntry | undefined {
    return SessionStore.list(rootDir).find((entry) => entry.cwd === cwd);
  }

  append(record: SessionRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  recordMessage(message: Message): void {
    this.append({ type: "message", payload: message });
    this.touch();
  }

  recordCheckpoint(payload: unknown): void {
    this.append({ type: "checkpoint", payload });
    this.touch();
  }

  private touch(): void {
    this.meta = { ...this.meta, updatedAt: new Date().toISOString() };
  }

  static loadMessages(id: string, rootDir?: string): Message[] {
    const path = join(SessionStore.baseDir(rootDir), `${id}.jsonl`);
    if (!existsSync(path)) return [];
    const messages: Message[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as SessionRecord;
        if (record.type === "message") messages.push(record.payload as Message);
      } catch {
        continue;
      }
    }
    return messages;
  }
}
