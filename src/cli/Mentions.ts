import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertInsideWorkspace, assertNoSymlinkEscape } from "../utils/paths.js";
import { samePath } from "../utils/platform.js";
import { isIgnoredDirName } from "../utils/ignoredDirs.js";

/**
 * `@path` mentions.
 *
 * The prompt cannot know which file the user means, but the user does. A mention
 * turns "look at this" into the file's content in the same message, which saves
 * the model a whole tool round-trip and keeps the relevant lines in front of it
 * after compaction.
 *
 * Everything here is pure filesystem work with hard bounds: a mention can never
 * read outside the workspace, never pull in a binary, and never blow the context
 * window on its own.
 */

/** Hard caps so one mention cannot eat the context window. */
export interface MentionLimits {
  /** Characters kept from a single file. */
  perFileChars: number;
  /** Characters kept from all mentions in one message. */
  totalChars: number;
  /** Mentions honoured in one message. */
  maxFiles: number;
  /** Files larger than this on disk are not read at all. */
  maxFileBytes: number;
}

export const DEFAULT_MENTION_LIMITS: MentionLimits = {
  perFileChars: 20000,
  totalChars: 60000,
  maxFiles: 8,
  maxFileBytes: 512 * 1024,
};

/**
 * Files the picker offers: what git tracks, which is the project's own idea of
 * its source. A directory that is not a repository falls back to a bounded walk.
 *
 * A home directory is never treated as a project: even the on-demand `@` picker
 * gets a shallow, capped walk so it cannot enumerate AppData, Windows or the
 * user's whole profile.
 */
export function listWorkspaceFiles(root: string, limit = 3000): string[] {
  if (samePath(root, homedir())) {
    return walkFiles(root, Math.min(limit, 200), 2);
  }
  const tracked = gitTrackedFiles(root);
  const files = tracked ?? walkFiles(root, limit);
  return files.slice(0, limit);
}

function gitTrackedFiles(root: string): string[] | undefined {
  try {
    // -z keeps names with spaces and quotes intact; --cached lists the index,
    // which is what the user sees in their editor.
    const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = raw
      .split("\u0000")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.split(sep).join("/"))
      .filter((entry) => !entry.split("/").some((part) => isIgnoredDirName(part)));
    return files.length > 0 ? files : undefined;
  } catch {
    return undefined;
  }
}

function walkFiles(root: string, limit: number, maxDepth = 8): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (isIgnoredDirName(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * Mentions in a line: `@path` at the start or after whitespace. An email
 * address is not a mention, which is why the `@` needs that boundary.
 */
export function parseMentions(text: string): string[] {
  const found: string[] = [];
  const pattern = /(^|\s)@([^\s@]+)/g;
  for (const match of text.matchAll(pattern)) {
    const path = (match[2] ?? "").replace(/[),.;:]+$/, "");
    if (path.length > 0 && !found.includes(path)) found.push(path);
  }
  return found;
}

export interface ExpandResult {
  /** The text handed to the model: the original line plus the file blocks. */
  text: string;
  /** Files whose content was attached. */
  attached: string[];
  /** Mentions that could not be attached, with the reason. */
  skipped: { path: string; reason: string }[];
}

/**
 * Turns a user line into the message the model receives. Missing or refused
 * mentions become a one-line marker instead of an error, because a typo in a
 * path must not kill the turn.
 */
export function expandMentions(
  text: string,
  root: string,
  limits: MentionLimits = DEFAULT_MENTION_LIMITS,
): ExpandResult {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { text, attached: [], skipped: [] };

  const blocks: string[] = [];
  const attached: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let budget = limits.totalChars;

  for (const mention of mentions) {
    if (attached.length >= limits.maxFiles) {
      skipped.push({ path: mention, reason: `only ${limits.maxFiles} files per message` });
      continue;
    }
    const target = isAbsolute(mention) ? mention : join(root, mention);
    if (assertInsideWorkspace(root, target) !== undefined) {
      skipped.push({ path: mention, reason: "outside the workspace" });
      continue;
    }
    // The lexical check above cannot see a symlink: `@link/secret` is inside the
    // workspace by name and outside it by realpath. Only realpath knows.
    if (assertNoSymlinkEscape(root, target) !== undefined) {
      skipped.push({ path: mention, reason: "symlink points outside the workspace" });
      continue;
    }
    if (!existsSync(target)) {
      skipped.push({ path: mention, reason: "not found" });
      continue;
    }
    let size = 0;
    try {
      const stat = statSync(target);
      if (!stat.isFile()) {
        skipped.push({ path: mention, reason: "not a file" });
        continue;
      }
      size = stat.size;
    } catch {
      skipped.push({ path: mention, reason: "unreadable" });
      continue;
    }
    if (size > limits.maxFileBytes) {
      skipped.push({ path: mention, reason: `larger than ${Math.round(limits.maxFileBytes / 1024)} KB` });
      continue;
    }
    let body: string;
    try {
      body = readFileSync(target, "utf8");
    } catch {
      skipped.push({ path: mention, reason: "unreadable" });
      continue;
    }
    // A NUL byte in the first block means binary; the model cannot use that.
    if (body.slice(0, 4096).includes("\u0000")) {
      skipped.push({ path: mention, reason: "binary file" });
      continue;
    }
    const allowance = Math.min(limits.perFileChars, budget);
    if (allowance <= 0) {
      skipped.push({ path: mention, reason: "mention budget exhausted" });
      continue;
    }
    const clipped = body.length > allowance ? `${body.slice(0, allowance)}\n… truncated` : body;
    budget -= clipped.length;
    const label = mention.split(sep).join("/");
    blocks.push(`<file path="${label}">\n${clipped.replace(/\n$/, "")}\n</file>`);
    attached.push(label);
  }

  const markers = skipped.map((entry) => `<file path="${entry.path}" error="${entry.reason}"/>`);
  if (blocks.length === 0 && markers.length === 0) return { text, attached, skipped };
  const passed = [...blocks, ...markers].join("\n");
  return { text: `${text}\n\n${passed}`, attached, skipped };
}
