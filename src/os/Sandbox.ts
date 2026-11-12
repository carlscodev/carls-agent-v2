import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { currentPlatform, isWindows } from "../utils/platform.js";

/**
 * Adaptive sandboxing.
 *
 * An autonomous agent runs a lot of generated shell commands, so a host that can
 * confine them should. Every mechanism here is optional and detected at runtime:
 * when none is available the command still runs, because refusing to work on a
 * machine without `bwrap` would be worse than the risk it removes. This module
 * never installs anything and never fails a run.
 */

export type SandboxKind = "bubblewrap" | "seatbelt" | "none";

export interface SandboxAvailability {
  kind: SandboxKind;
  /** Executable that implements it, when one was found. */
  binary?: string;
  /** Why it is unavailable, for `/doctor` and the receipt. */
  reason?: string;
}

export interface SandboxCommand {
  /** Executable to spawn instead of the shell. */
  file: string;
  /** Arguments before the shell invocation. */
  args: string[];
}

function which(binary: string): string | undefined {
  const finder = isWindows() ? "where" : "which";
  try {
    const output = execFileSync(finder, [binary], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

export function detectSandbox(): SandboxAvailability {
  const platform = currentPlatform();

  if (platform === "linux" || platform === "android") {
    const bwrap = which("bwrap");
    if (bwrap !== undefined) return { kind: "bubblewrap", binary: bwrap };
    return { kind: "none", reason: "bubblewrap (bwrap) is not installed" };
  }

  if (platform === "darwin") {
    // sandbox-exec ships with macOS, so it is present unless it was removed.
    if (existsSync("/usr/bin/sandbox-exec")) {
      return { kind: "seatbelt", binary: "/usr/bin/sandbox-exec" };
    }
    return { kind: "none", reason: "sandbox-exec is not present" };
  }

  if (platform === "win32") {
    // Job Objects need a native addon; there is none in this dependency tree.
    return { kind: "none", reason: "no portable process confinement on Windows without a native module" };
  }

  return { kind: "none", reason: `no sandbox mechanism for ${platform}` };
}

/** The profile string Seatbelt accepts: no writes, network still allowed. */
const SEATBELT_PROFILE = "(version 1)(allow default)(deny file-write*)";

/**
 * Wraps a shell invocation so it runs inside the available sandbox.
 *
 * Returns `undefined` when nothing is available, which the caller reads as "run
 * it directly". A read-only bubblewrap mount is deliberately not used: the agent
 * has to write inside the workspace, so only the parts of the filesystem it has
 * no business in are hidden.
 */
export function sandboxCommand(
  shellFile: string,
  shellArgs: string[],
  command: string,
  cwd: string,
): SandboxCommand | undefined {
  const availability = detectSandbox();
  if (availability.binary === undefined) return undefined;

  if (availability.kind === "bubblewrap") {
    return {
      file: availability.binary,
      args: [
        "--dev-bind",
        "/",
        "/",
        "--bind",
        cwd,
        cwd,
        "--chdir",
        cwd,
        "--unshare-pid",
        "--die-with-parent",
        shellFile,
        ...shellArgs,
        command,
      ],
    };
  }

  if (availability.kind === "seatbelt") {
    return {
      file: availability.binary,
      args: ["-p", SEATBELT_PROFILE, shellFile, ...shellArgs, command],
    };
  }

  return undefined;
}
