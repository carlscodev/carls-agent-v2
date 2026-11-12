import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isWindows } from "./platform.js";

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** True when `target` is inside `root` (or is `root` itself). */
export function isInside(root: string, target: string): boolean {
  const from = resolve(root);
  const to = resolve(target);
  // Windows paths compare case-insensitively, and a different drive letter is
  // never inside the root.
  const rel = isWindows()
    ? relative(from.toLowerCase(), to.toLowerCase())
    : relative(from, to);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function toDisplayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  return rel.length > 0 && !rel.startsWith("..") ? rel : target;
}

/** Thrown when a tool tries to reach outside the workspace root. */
export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

/** The minimum a caller must expose for `guardPath`: a root and the opt-out. */
export interface GuardContext {
  cwd: string;
  config: { allowOutsideWorkspace: boolean };
}

/**
 * Resolves a tool path and refuses anything outside the workspace unless the
 * config opts out. Throwing keeps every call site free of error plumbing: the
 * agent loop turns it into a normal tool error the model can read.
 */
export function guardPath(ctx: GuardContext, path: string): string {
  const target = resolvePath(ctx.cwd, path);
  const problem =
    assertInsideWorkspace(ctx.cwd, target, ctx.config.allowOutsideWorkspace) ??
    assertNoSymlinkEscape(ctx.cwd, target, ctx.config.allowOutsideWorkspace);
  if (problem !== undefined) throw new PathGuardError(problem);
  return target;
}

/**
 * Resolves symlinks on the deepest part of the path that exists and re-checks
 * containment. Without this, `ln -s /etc ./link` followed by a read of
 * `./link/shadow` would pass the lexical check above.
 */
export function assertNoSymlinkEscape(
  cwd: string,
  target: string,
  allowOutside = false,
): string | undefined {
  if (allowOutside) return undefined;
  let probe = resolvePath(cwd, target);
  // Walk up to the first existing ancestor; the rest cannot be a symlink yet.
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (!existsSync(probe)) return undefined;
  let realRoot: string;
  let realProbe: string;
  try {
    realRoot = realpathSync(resolvePath(cwd, "."));
    realProbe = realpathSync(probe);
  } catch (error) {
    // Fail closed. If the real path cannot be established, containment cannot
    // be proven, and "probably inside" is not a reason to open a file.
    return `refusing to touch "${target}": could not resolve its real path (${(error as Error).message.split("\n")[0] ?? "unknown error"}).`;
  }
  if (isInside(realRoot, realProbe)) return undefined;
  return `refusing to touch "${target}": it resolves through a symlink to "${realProbe}", outside the workspace (${realRoot}).`;
}

/**
 * Rejects paths that escape the workspace. Absolute paths outside the root are
 * refused unless `allowOutside` is set, which keeps a prompt-injected tool call
 * from reading ~/.ssh or C:\Windows.
 */
export function assertInsideWorkspace(
  cwd: string,
  target: string,
  allowOutside = false,
): string | undefined {
  if (allowOutside) return undefined;
  const resolved = resolvePath(cwd, target);
  if (isInside(cwd, resolved)) return undefined;
  return `refusing to touch "${target}": it is outside the workspace (${cwd}). Pass an absolute path inside the workspace, or run carls from that directory.`;
}
