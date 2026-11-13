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
  /** Number of user turns recorded in the log. */
  turns?: number;
  /** First user prompt, whitespace-collapsed and clipped. */
  opening?: string;
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
        // The log is append-only, so a session that kept going has several meta
        // records; the last one carries the freshest `updatedAt`, which is what
        // the "most recent first" ordering needs. The same pass counts turns and
        // keeps the opening prompt, so `--resume` does not re-read every log.
        let meta: SessionMeta | undefined;
        let turns = 0;
        let opening: string | undefined;
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line) as SessionRecord;
          if (record.type === "meta") {
            meta = record.payload as SessionMeta;
            continue;
          }
          if (record.type !== "message") continue;
          const message = record.payload as Message;
          if (message.role !== "user") continue;
          const text = message.content
            .filter((block): block is Extract<Message["content"][number], { type: "text" }> => block.type === "text")
            .map((block) => block.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          // Tool results are also stored as user-role messages. Only a real
          // prompt counts as a turn and can name the session.
          if (text.length === 0) continue;
          turns += 1;
          if (opening === undefined) {
            opening = text.length > 120 ? `${text.slice(0, 119)}…` : text;
          }
        }
        if (meta !== undefined) {
          entries.push({
            ...meta,
            path: full,
            turns,
            ...(opening !== undefined ? { opening } : {}),
          });
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

  /**
   * Durability point for a clean exit. The log is append-only and written with
   * `appendFileSync`, so the bytes are already on disk; re-emitting the meta
   * record also refreshes `updatedAt` so `--resume` picks this session first.
   */
  flush(): void {
    this.touch();
  }

  private touch(): void {
    this.meta = { ...this.meta, updatedAt: new Date().toISOString() };
    // Persisted so `SessionStore.list()` can order by real recency; without this
    // every session keeps the timestamp it was created with.
    this.append({ type: "meta", payload: this.meta });
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
