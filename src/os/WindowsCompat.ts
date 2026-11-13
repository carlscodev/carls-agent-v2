import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, win32 } from "node:path";

/**
 * Native Windows behaviour that the rest of the harness can rely on without
 * growing another platform branch in every tool.
 *
 * Three things break a "works on Linux" agent on win32 far more often than the
 * missing shell does: a path spelling that compares unequal to itself, an
 * executable that needs an intermediate shell it did not ask for, and a child
 * process that answers in a legacy code page. They are collected here so the
 * fixes stay testable without a Windows CI runner for the pure parts.
 */

export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";

/** Longest path the Win32 API accepts without the extended prefix. */
export const WINDOWS_MAX_PATH = 260;

export type WindowsLauncher = "direct" | "cmd" | "powershell";

export interface WindowsExecutable {
  /** Absolute, drive-letter-normalised path of the executable. */
  file: string;
  /** How it has to be started: directly, through cmd.exe or PowerShell. */
  launcher: WindowsLauncher;
  /** The PATHEXT entry that matched, upper-cased and including the dot. */
  extension: string;
}

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Defaults to the host platform; tests pass "win32" on any host. */
  platform?: NodeJS.Platform;
  /** Injection point for tests that do not want to touch the filesystem. */
  isFile?: (path: string) => boolean;
}

function hostIsWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/**
 * Git Bash and MSYS hand a Windows binary `/c/project` where the Win32 API
 * expects `C:\project`. Only the drive form is rewritten: a real rooted path
 * such as `/tmp` keeps its meaning.
 */
export function msysToWindowsPath(input: string): string {
  const match = /^\/([A-Za-z])(?:\/|$)/.exec(input);
  if (match === null) return input;
  const drive = `${(match[1] ?? "").toUpperCase()}:`;
  const rest = input.slice(match[0].length);
  if (rest.length === 0) return `${drive}\\`;
  return `${drive}\\${rest.replace(/\//g, "\\")}`;
}

/**
 * Canonical spelling for a Windows path: native separators, one normalised
 * drive letter and no `.`/`..` noise. The extended `\\?\` prefix is preserved
 * because it changes how the path is interpreted, not only how it looks.
 */
export function normalizeWindowsPath(input: string): string {
  let value = msysToWindowsPath(input).replace(/\//g, "\\");
  const extended = /^\\\\\?\\/.test(value);
  if (!extended) value = win32.normalize(value);
  const drive = /^([A-Za-z]):/.exec(value);
  if (drive !== null) {
    value = `${(drive[1] ?? "").toUpperCase()}:${value.slice(2)}`;
  } else {
    // `\\?\c:\...` carries the drive after the prefix.
    value = value.replace(/^(\\\\\?\\[A-Za-z]:)/, (match) => match.toUpperCase());
  }
  return value;
}

/**
 * Identity for a path on Windows. The whole path is lower-cased because NTFS
 * is case-insensitive; the drive is canonicalised first so `c:\` and `C:\` are
 * the same key before the comparison. It is not a display value.
 */
export function windowsPathKey(input: string): string {
  return normalizeWindowsPath(input).toLowerCase();
}

/** True when a path already carries the `\\?\` (or device) prefix. */
export function hasExtendedLengthPrefix(input: string): boolean {
  return /^\\\\[?.]\\/.test(input);
}

/**
 * Adds `\\?\` (or `\\?\UNC\` for a share) so the Win32 API bypasses MAX_PATH
 * and its own dot-segment processing. Relative paths are returned untouched:
 * the prefix is only valid for absolute paths.
 */
export function toExtendedLengthPath(input: string): string {
  const value = normalizeWindowsPath(input);
  if (hasExtendedLengthPrefix(value)) return value;
  if (value.startsWith("\\\\")) return `\\\\?\\UNC\\${value.slice(2)}`;
  if (/^[A-Z]:\\/.test(value)) return `\\\\?\\${value}`;
  return value;
}

/** Removes the extended prefix, for display and for tools that reject it. */
export function stripExtendedLengthPath(input: string): string {
  if (/^\\\\\?\\UNC\\/i.test(input)) return `\\\\${input.slice("\\\\?\\UNC\\".length)}`;
  if (/^\\\\\?\\/i.test(input)) return input.slice("\\\\?\\".length);
  return input;
}

/**
 * Extended form only when it is actually needed. Applying it eagerly changes
 * how `..` is resolved, so short paths stay in their familiar spelling.
 */
export function normalizeWindowsLongPath(
  input: string,
  threshold: number = WINDOWS_MAX_PATH,
): string {
  const value = normalizeWindowsPath(input);
  return value.length >= threshold && isAbsolute(value) ? toExtendedLengthPath(value) : value;
}

/** PATHEXT entries in lookup order, de-duplicated and upper-cased. */
export function windowsPathExt(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? DEFAULT_PATHEXT;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const part of raw.split(";")) {
    const entry = part.trim().toUpperCase();
    if (!entry.startsWith(".") || entry.length < 2 || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.length > 0 ? entries : DEFAULT_PATHEXT.split(";");
}

function launcherForExtension(extension: string): WindowsLauncher {
  if (extension === ".PS1") return "powershell";
  if (extension === ".BAT" || extension === ".CMD") return "cmd";
  return "direct";
}

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    // A path that cannot be inspected is not an executable we can trust.
    return false;
  }
}

function matchInDirectory(
  directory: string,
  name: string,
  extensions: string[],
  isFile: (path: string) => boolean,
): WindowsExecutable | undefined {
  const base = win32.join(directory, name);
  const lower = base.toLowerCase();
  const known = extensions.find((extension) => lower.endsWith(extension.toLowerCase()));
  // An explicit `.exe`, `.cmd`, ... wins over appending another extension.
  if (known !== undefined && isFile(base)) {
    return { file: normalizeWindowsPath(base), launcher: launcherForExtension(known), extension: known };
  }
  for (const extension of extensions) {
    if (lower.endsWith(extension.toLowerCase())) continue;
    const candidate = `${base}${extension}`;
    if (isFile(candidate)) {
      return {
        file: normalizeWindowsPath(candidate),
        launcher: launcherForExtension(extension),
        extension,
      };
    }
  }
  // A file whose extension PATHEXT omits is not directly executable by
  // CreateProcess. Only the two native executable formats are safe to run
  // without a shell (this also covers a cleared PATHEXT and `carls.exe`).
  const extension = win32.extname(base).toUpperCase();
  if ((extension === ".EXE" || extension === ".COM") && isFile(base)) {
    return { file: normalizeWindowsPath(base), launcher: "direct", extension };
  }
  return undefined;
}

/**
 * Resolves an executable the way CreateProcess does, plus PATHEXT and without
 * the current directory.
 *
 * Windows' own lookup searches the process working directory before PATH, which
 * turns a file the agent just wrote into code that runs on the next `git`
 * call. A bare name is therefore resolved from absolute PATH entries only;
 * empty and relative entries are skipped. An explicit path (with a separator or
 * a drive) is still honoured, because that is a deliberate request.
 */
export function resolveWindowsExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): WindowsExecutable | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!hostIsWindows(platform)) return undefined;

  const name = command.trim();
  if (name.length === 0 || /["\r\n]/.test(name)) return undefined;
  const extensions = windowsPathExt(env);
  const isFile = options.isFile ?? defaultIsFile;

  const hasSeparator = /[\\/]/.test(name) || /^[A-Za-z]:/.test(name);
  if (hasSeparator) {
    const cwd = options.cwd ?? process.cwd();
    const target = isAbsolute(name) ? normalizeWindowsPath(name) : win32.resolve(cwd, name);
    const directory = win32.dirname(target);
    return matchInDirectory(directory, win32.basename(target), extensions, isFile);
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const rawEntry of pathValue.split(";")) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    // An empty entry means the current directory to CreateProcess. Following it
    // would let a workspace file hijack a tool invocation.
    if (entry.length === 0 || !win32.isAbsolute(entry)) continue;
    const match = matchInDirectory(entry, name, extensions, isFile);
    if (match !== undefined) return match;
  }
  return undefined;
}

/**
 * Conservative splitter for the simple `tool arg arg` form. Returning
 * `undefined` is the safe answer: the caller then keeps the platform shell,
 * which understands pipes, redirection, variables and built-ins. The point is
 * only to skip a shell when skipping it cannot change the meaning.
 */
export function splitSimpleCommandLine(command: string): string[] | undefined {
  const line = command.trim();
  if (line.length === 0) return undefined;
  // Shell metacharacters: operators, expansion, globbing, comments, and the
  // single-quote form, whose semantics differ between PowerShell and cmd.exe.
  // Double quotes are allowed because the tokenizer below understands them.
  if (/[|&;<>()$`%!*?{}\[\]\r\n#']/.test(line)) return undefined;

  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === undefined) continue;
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (quoted) {
        current += char;
        continue;
      }
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quoted) return undefined;
  if (started) tokens.push(current);
  return tokens.length > 0 ? tokens : undefined;
}

export interface DirectCommandPlan {
  file: string;
  args: string[];
  launcher: WindowsLauncher;
  extension: string;
}

/**
 * Full plan for a command that can run without an intermediate shell. Only the
 * `direct` launcher is a real bypass: `.cmd`, `.bat` and `.ps1` still need
 * their interpreter, and callers that want to avoid PowerShell can use the
 * returned launcher instead of guessing from the file name.
 */
export function planDirectWindowsCommand(
  command: string,
  options: ResolveExecutableOptions = {},
): DirectCommandPlan | undefined {
  const tokens = splitSimpleCommandLine(command);
  if (tokens === undefined) return undefined;
  const [executable, ...args] = tokens;
  if (executable === undefined) return undefined;
  const resolved = resolveWindowsExecutable(executable, options);
  if (resolved === undefined) return undefined;
  // A shell started directly would lose the UTF-8 prologue the platform-shell
  // path prepends, turning `powershell -Command "Write-Output ñ"` into mojibake.
  // Send these through `shellForPlatform()` instead.
  const name = basename(resolved.file).toLowerCase();
  if (name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe" || name === "cmd" || name === "cmd.exe") {
    return undefined;
  }
  return { file: resolved.file, args, launcher: resolved.launcher, extension: resolved.extension };
}

/**
 * Environment that makes a Windows child emit UTF-8 instead of its legacy
 * ANSI/OEM code page. The Python variables are harmless for other children.
 */
export function windowsUtf8Environment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    LANG: base.LANG ?? "C.UTF-8",
    LC_ALL: base.LC_ALL ?? "C.UTF-8",
    CARLS_UTF8: "1",
  };
}

/** Only the variables above, for callers that merge their own environment. */
export function windowsUtf8Overrides(): Record<string, string> {
  return {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CARLS_UTF8: "1",
  };
}

/**
 * Prologue that switches an already-running shell to UTF-8. It is prepended to
 * the command rather than passed as a flag because cmd.exe and PowerShell
 * disagree on every flag name; this text is valid in both.
 */
export function utf8PreludeForShell(shellFile: string): string {
  const name = basename(shellFile).toLowerCase();
  if (name === "cmd" || name === "cmd.exe") return "chcp 65001>nul&";
  if (name.includes("powershell") || name === "pwsh" || name === "pwsh.exe") {
    return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[Console]::OutputEncoding;";
  }
  return "";
}

/** Cursor visible, mouse/paste/alternate-screen off, sync mode closed. */
export const CONSOLE_RESTORE_SEQUENCE =
  "\u001b[?1006l\u001b[?1002l\u001b[?1000l\u001b[?2004l\u001b[?2026l\u001b[?1049l\u001b[?25h\u001b[r";

export interface ConsoleTarget {
  isTTY?: boolean;
  write: (chunk: string) => unknown;
}

/** Restores the terminal only when the target really owns one. */
export function restoreConsoleState(target: ConsoleTarget = process.stderr): boolean {
  if (target.isTTY !== true) return false;
  target.write(CONSOLE_RESTORE_SEQUENCE);
  return true;
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

let restoreHooksInstalled = false;

/**
 * Guarantees the cursor comes back when the process leaves abnormally.
 *
 * PowerShell and cmd.exe keep the hidden-cursor state if the child dies before
 * its own cleanup, which is what makes the prompt look frozen. The `exit`
 * event covers `process.exit` and a drained event loop; the monitor covers an
 * uncaught exception without changing Node's crash behaviour; signals are
 * handled only when nobody else owns them, so the REPL's Ctrl+C cancellation
 * keeps working after this hook is installed.
 *
 * Returns a disposer, used by tests and by long-lived hosts that reload.
 */
export function installConsoleRestoreHooks(platform: NodeJS.Platform = process.platform): () => void {
  if (!hostIsWindows(platform) || restoreHooksInstalled) return () => undefined;
  restoreHooksInstalled = true;

  const onExit = (): void => {
    restoreConsoleState(process.stderr);
  };
  const onUncaught = (): void => {
    restoreConsoleState(process.stderr);
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  process.once("exit", onExit);
  process.once("uncaughtExceptionMonitor", onUncaught);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    // A handler installed later (the REPL's) must keep ownership; this listener
    // only restores the terminal and lets the owner decide whether to exit.
    const handler = (): void => {
      restoreConsoleState(process.stderr);
      if (process.listenerCount(signal) === 1) {
        process.exit(128 + (SIGNAL_NUMBERS[signal] ?? 1));
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    restoreHooksInstalled = false;
    process.off("exit", onExit);
    process.off("uncaughtExceptionMonitor", onUncaught);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    signalHandlers.clear();
  };
}
