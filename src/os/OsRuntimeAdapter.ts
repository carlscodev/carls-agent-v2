import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  currentPlatform,
  isTermux,
  isWindows,
  shellForPlatform,
  type Platform,
  type ShellSpec,
} from "../utils/platform.js";

/**
 * One place that answers "which machine am I on, and what does that change".
 *
 * The rest of the harness already passes an explicit `cwd` to every subprocess,
 * so a stray `cd` cannot desynchronise the session. What remains is the set of
 * differences that genuinely break a run on an unfamiliar host: the shell that
 * exists, the path flavour, whether POSIX tools can be assumed, and the encoding
 * a child writes its output in.
 */

export interface OsProfile {
  platform: Platform;
  /** Node's raw value, kept for diagnostics and bug reports. */
  raw: NodeJS.Platform;
  termux: boolean;
  shell: ShellSpec;
  /**
   * True when coreutils-style tools (grep, find, sed) can be assumed. False on
   * Windows, where a shell command written for Linux fails in confusing ways.
   */
  posix: boolean;
  pathSeparator: string;
  /** Extra environment that forces UTF-8 out of a child process. */
  env: Record<string, string>;
}

/**
 * Windows defaults to a legacy code page, so a child that prints an accent or a
 * box-drawing glyph returns mojibake that then enters the model's context. Both
 * families get told to emit UTF-8; the variables are harmless where unused.
 */
export function utf8Env(): Record<string, string> {
  if (isWindows()) {
    return {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
  }
  return {
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
  };
}

export function detectOsProfile(): OsProfile {
  const platform = currentPlatform();
  return {
    platform,
    raw: osPlatform(),
    termux: isTermux(),
    shell: shellForPlatform(),
    posix: !isWindows(),
    pathSeparator: sep,
    env: utf8Env(),
  };
}

/**
 * Deterministic path normalisation: expands a leading `~`, makes the path
 * absolute against `base`, and collapses `.`/`..` and duplicate separators.
 * Two spellings of the same file must compare equal, or a tool reports an edit
 * to a path the agent never mentioned.
 */
export function normalizeWorkspacePath(input: string, base: string): string {
  let expanded = input;
  if (input === "~") {
    expanded = homedir();
  } else if (input.startsWith("~/") || input.startsWith("~\\")) {
    expanded = join(homedir(), input.slice(2));
  }
  return normalize(isAbsolute(expanded) ? expanded : resolve(base, expanded));
}

export interface CwdIntegrity {
  ok: boolean;
  path: string;
  reason?: string;
}

/**
 * Re-checks the session root after a command has run.
 *
 * A long shell command can delete, rename or replace the directory it ran in.
 * When that happens every later tool fails with a confusing ENOENT, and the
 * model tends to invent a reason for it. Catching it here turns a silent
 * corruption into one explicit observation.
 */
export function verifyCwdIntegrity(cwd: string): CwdIntegrity {
  const absolute = resolve(cwd);
  if (!existsSync(absolute)) {
    return { ok: false, path: absolute, reason: "the working directory no longer exists" };
  }
  try {
    if (!statSync(absolute).isDirectory()) {
      return { ok: false, path: absolute, reason: "the working directory is no longer a directory" };
    }
  } catch (error) {
    return {
      ok: false,
      path: absolute,
      reason: `the working directory could not be inspected: ${(error as Error).message.split("\n")[0] ?? "unknown error"}`,
    };
  }
  return { ok: true, path: absolute };
}

/**
 * Kills a process and everything it spawned.
 *
 * `child.kill()` signals one process; a shell that started a test runner leaves
 * the runner and its workers behind, holding ports and file locks. On POSIX the
 * child is spawned detached so it leads its own process group, and a negative
 * pid reaches the whole group. Windows has no process groups reachable this way,
 * so `taskkill /T` walks the tree instead.
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined || pid <= 0) return;

  if (isWindows()) {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // The tree is already gone, which is the outcome we wanted.
    }
    return;
  }

  // Negative pid targets the group. It fails with ESRCH when the child was not
  // made a group leader, so fall back to the single process.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall through to the direct signal below.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

/** True when the child must be spawned detached for `killProcessTree` to work. */
export function needsDetachedGroup(): boolean {
  return !isWindows();
}
