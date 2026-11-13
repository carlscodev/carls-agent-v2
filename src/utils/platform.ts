import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join, posix, win32 } from "node:path";

export type Platform = "win32" | "darwin" | "linux" | "android" | "other";

/**
 * Termux ships its own filesystem layout under the app sandbox, and Node reports
 * either `android` (official builds) or `linux` (some Termux packages) for it, so
 * the environment variables are the reliable signal.
 */
export function isTermux(): boolean {
  return (
    osPlatform() === "android" ||
    process.env.TERMUX_VERSION !== undefined ||
    (process.env.PREFIX?.includes("com.termux") ?? false)
  );
}

export function currentPlatform(): Platform {
  // Android is checked first: a Termux install must not fall through to the
  // generic Linux branch, which assumes /bin/bash and /etc.
  if (isTermux()) return "android";
  const value = osPlatform();
  if (value === "win32") return "win32";
  if (value === "darwin") return "darwin";
  if (value === "linux") return "linux";
  return "other";
}

export function isWindows(): boolean {
  return currentPlatform() === "win32";
}

export interface ShellSpec {
  /** Executable to spawn. */
  file: string;
  /** Arguments that make it run the command string, before the command. */
  args: string[];
  /** Human label used in prompts and error messages. */
  label: string;
  /**
   * Appended to every command string. PowerShell's `-Command` collapses any
   * native non-zero exit into 1, so a hook or a tool that exits 2 or 3 would
   * lose its code; `exit $LASTEXITCODE` restores it. POSIX shells already
   * propagate the status, and cmd.exe does too.
   */
  commandSuffix?: string;
}

/**
 * Picks the shell used by the `bash` tool. On Windows the tool is misnamed on
 * purpose: `cmd.exe` is always present, while PowerShell is preferred when it
 * is available because its quoting and error handling are predictable.
 * Override with $CARLS_SHELL to use Git Bash, WSL or anything else.
 */
export function shellForPlatform(): ShellSpec {
  const override = process.env.CARLS_SHELL;
  if (override !== undefined && override.length > 0) {
    return { file: override, args: ["-lc"], label: override };
  }

  if (isWindows()) {
    if (existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")) {
      return {
        file: "powershell.exe",
        args: ["-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
        label: "PowerShell",
        commandSuffix: "; exit $LASTEXITCODE",
      };
    }
    const pwsh = process.env.PWSH_PATH;
    if (pwsh !== undefined && existsSync(pwsh)) {
      return {
        file: pwsh,
        args: ["-NoLogo", "-NonInteractive", "-Command"],
        label: "PowerShell 7",
        commandSuffix: "; exit $LASTEXITCODE",
      };
    }
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"], label: "cmd.exe" };
  }

  // Termux has no /bin/bash; the shell lives under $PREFIX/bin. The prefix is
  // always a POSIX path, even when a test simulates Termux on a Windows host,
  // so it must not be joined with the host separator.
  if (currentPlatform() === "android") {
    const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
    const termuxBash = posix.join(prefix, "bin", "bash");
    if (existsSync(termuxBash)) return { file: termuxBash, args: ["-lc"], label: "Termux bash" };
    return { file: posix.join(prefix, "bin", "sh"), args: ["-lc"], label: "Termux sh" };
  }

  return { file: "/bin/bash", args: ["-lc"], label: "bash" };
}

/**
 * Config locations, most specific last. Windows has no /etc, so the machine
 * layer comes from %PROGRAMDATA% and the user layer from %APPDATA%.
 */
export function systemConfigPath(): string {
  if (isWindows()) {
    const base = process.env.PROGRAMDATA ?? "C:\\ProgramData";
    return join(base, "carls", ".carlsrc.json");
  }
  // Termux has no /etc; the writable equivalent is $PREFIX/etc. The prefix is
  // POSIX-shaped regardless of the host that is simulating it.
  if (currentPlatform() === "android") {
    const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
    return posix.join(prefix, "etc", "carls", ".carlsrc.json");
  }
  return join("/etc", "carls", ".carlsrc.json");
}

export function userConfigPath(): string {
  if (isWindows()) {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "carls", ".carlsrc.json");
  }
  return join(homedir(), ".carlsrc.json");
}

export function userDataDir(): string {
  if (isWindows()) {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "carls");
  }
  return join(homedir(), ".carls");
}

/** True when `a` and `b` name the same path, honouring Windows case rules. */
export function samePath(a: string, b: string): boolean {
  if (isWindows()) return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  return a === b;
}

/**
 * `which` on POSIX, `where` on Windows. Returns the command to run and its
 * arguments so callers stay free of platform branches.
 */
export function whichCommand(): { file: string; args: string[] } {
  return isWindows() ? { file: "where", args: [] } : { file: "which", args: [] };
}

export interface ClipboardCommands {
  read: ShellSpec[];
  write: ShellSpec[];
}

/** Clipboard helpers per platform, tried in order until one succeeds. */
export function clipboardCommands(): ClipboardCommands {
  if (isWindows()) {
    return {
      read: [
        {
          file: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
          label: "PowerShell Get-Clipboard",
        },
      ],
      write: [
        {
          file: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
          label: "PowerShell Set-Clipboard",
        },
      ],
    };
  }
  if (currentPlatform() === "darwin") {
    return {
      read: [{ file: "pbpaste", args: [], label: "pbpaste" }],
      write: [{ file: "pbcopy", args: [], label: "pbcopy" }],
    };
  }
  return {
    read: [
      { file: "xclip", args: ["-selection", "clipboard", "-o"], label: "xclip" },
      { file: "xsel", args: ["--clipboard", "--output"], label: "xsel" },
    ],
    write: [
      { file: "xclip", args: ["-selection", "clipboard"], label: "xclip" },
      { file: "xsel", args: ["--clipboard", "--input"], label: "xsel" },
    ],
  };
}

/** Command that lists processes, with a filter argument when one is needed. */
export function processListCommand(): ShellSpec {
  if (isWindows()) {
    return {
      file: "tasklist",
      args: ["/FO", "CSV", "/NH"],
      label: "tasklist",
    };
  }
  return { file: "ps", args: ["-eo", "pid,ppid,pcpu,pmem,etime,comm,args", "--sort=-pcpu"], label: "ps" };
}

/**
 * Windows terminals need virtual-terminal processing switched on for ANSI
 * colours and cursor movement to work. Node does this for its own streams, but
 * not for a child's, so the interactive REPL asks for it explicitly.
 */
export function enableWindowsVirtualTerminal(): void {
  if (!isWindows()) return;
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "$null=[console]::OutputEncoding=[System.Text.Encoding]::UTF8"],
      { stdio: "ignore" },
    );
  } catch {
    // Best effort: without it the output is plain but still usable.
  }
}

/** Joins path segments for the current platform. */
export function joinPath(...parts: string[]): string {
  return isWindows() ? win32.join(...parts) : join(...parts);
}
