import { homedir } from "node:os";
import type { SessionIndexEntry } from "../core/SessionStore.js";

/** Compact age for a session timestamp: `now`, `5m`, `3h`, `2d`, `4w`. */
export function relativeSessionAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "?";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** `~`-shortened workspace path, for a one-line session row. */
export function shortSessionCwd(cwd: string): string {
  const home = homedir();
  if (home.length > 1 && cwd.startsWith(home)) {
    const rest = cwd.slice(home.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
    return rest.length > 0 ? `~/${rest}` : "~";
  }
  return cwd;
}

/**
 * One session row shared by the completion menu and the interactive selector:
 * `age · cwd · "opening" (N msgs)`. The session id stays as the row label so
 * accepting it always inserts an id, never a filesystem path.
 */
export function sessionDetail(entry: SessionIndexEntry): string {
  const turns = entry.turns ?? 0;
  const opening = (entry.opening ?? "(no prompt)")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return `${relativeSessionAge(entry.updatedAt)} · ${shortSessionCwd(entry.cwd)} · "${opening}" (${turns} msg${
    turns === 1 ? "" : "s"
  })`;
}
