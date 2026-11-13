import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { normalizeWindowsPath } from "./WindowsCompat.js";
import { buildLayout } from "./WindowsNativeBuild.js";

/**
 * Per-user installation without npm.
 *
 * The target is `%LOCALAPPDATA%\carls\bin`, which needs no administrator and
 * survives a Node upgrade. `npm link` is not used: its shim is a `.cmd` that
 * starts npm's own batch file before Node even runs. The one piece of global
 * state is the User Path in `HKCU\Environment`, and it is read with the raw
 * registry API (not `%VAR%`-expanded and not `setx`, which truncates at 1024
 * characters) before anything is written.
 */

export interface WindowsInstallPaths {
  localAppData: string;
  baseDir: string;
  binDir: string;
  exeFile: string;
  bundleFile: string;
  cmdFile: string;
}

export function windowsInstallPaths(env: NodeJS.ProcessEnv = process.env): WindowsInstallPaths {
  const localAppData =
    env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA.length > 0
      ? env.LOCALAPPDATA
      : join(env.USERPROFILE ?? homedir(), "AppData", "Local");
  const baseDir = join(localAppData, "carls");
  const binDir = join(baseDir, "bin");
  return {
    localAppData,
    baseDir,
    binDir,
    exeFile: join(binDir, "carls.exe"),
    bundleFile: join(binDir, "carls.bundle.cjs"),
    cmdFile: join(binDir, "carls.cmd"),
  };
}

export type RegistryValueKind = "REG_SZ" | "REG_EXPAND_SZ";

export interface RegistryValue {
  value: string;
  kind: RegistryValueKind;
}

/** The two operations the installer needs from the user environment. */
export interface UserEnvironmentRegistry {
  read(name: string): RegistryValue | undefined;
  write(name: string, value: string, kind: RegistryValueKind): void;
}

interface RegistryCommandOptions {
  powershell?: string;
  execFile?: typeof execFileSync;
}

function kindOf(raw: string): RegistryValueKind {
  return raw.toUpperCase().includes("EXPAND") ? "REG_EXPAND_SZ" : "REG_SZ";
}

/**
 * PowerShell is used instead of `reg.exe` because the output has to be decoded
 * as UTF-8 and because a user's Path may contain characters that would be
 * mangled by command-line quoting. The value travels through the environment,
 * and `DoNotExpandEnvironmentNames` keeps `%USERPROFILE%`-style entries intact.
 */
export function createUserEnvironmentRegistry(
  options: RegistryCommandOptions = {},
): UserEnvironmentRegistry {
  const powershell = options.powershell ?? "powershell.exe";
  const execFile = options.execFile ?? execFileSync;

  const readScript = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
    "if ($null -eq $key) { exit 0 }",
    "$value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "if ($null -eq $value) { exit 0 }",
    "$kind = $key.GetValueKind('Path').ToString()",
    "ConvertTo-Json -Compress @{ value = [string]$value; kind = $kind }",
  ].join("; ");

  const writeScript = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
    "$kind = [Microsoft.Win32.RegistryValueKind]$env:CARLS_PATH_KIND",
    "$key.SetValue('Path', $env:CARLS_PATH_VALUE, $kind)",
    "try {",
    "  Add-Type -Namespace CarlsInstall -Name Native -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    "  $result = [UIntPtr]::Zero",
    "  [void][CarlsInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
    "} catch { }",
  ].join("; ");

  return {
    read(name: string): RegistryValue | undefined {
      if (name.toLowerCase() !== "path") throw new Error(`Unsupported registry value: ${name}`);
      const output = String(
        execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", readScript], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
      ).trim();
      if (output.length === 0) return undefined;
      try {
        const parsed = JSON.parse(output) as { value?: unknown; kind?: unknown };
        if (typeof parsed.value !== "string") return undefined;
        return {
          value: parsed.value,
          kind: kindOf(typeof parsed.kind === "string" ? parsed.kind : "REG_SZ"),
        };
      } catch {
        return undefined;
      }
    },

    write(name: string, value: string, kind: RegistryValueKind): void {
      if (name.toLowerCase() !== "path") throw new Error(`Unsupported registry value: ${name}`);
      execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", writeScript], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, CARLS_PATH_VALUE: value, CARLS_PATH_KIND: kind },
      });
    },
  };
}

/** Expands `%NAME%` so a registry entry can be compared with an expanded one. */
export function expandWindowsEnvironment(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const found = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? match;
  });
}

function pathEntryKey(entry: string, env: NodeJS.ProcessEnv): string {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return "";
  const expanded = expandWindowsEnvironment(trimmed, env);
  return normalizeWindowsPath(expanded)
    .replace(/\\+$/, "")
    .toLowerCase();
}

export interface PathMutation {
  value: string;
  changed: boolean;
}

/**
 * Appends one entry, case-insensitively and without touching the rest of the
 * string. Existing separators, spaces and other entries are preserved so a
 * long corporate Path cannot be truncated by the installer.
 */
export function addToUserPath(
  existing: string | undefined,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): PathMutation {
  const current = existing ?? "";
  const wanted = pathEntryKey(entry, env);
  if (wanted.length === 0) return { value: current, changed: false };
  const parts = current.split(";");
  if (parts.some((part) => pathEntryKey(part, env) === wanted)) {
    return { value: current, changed: false };
  }
  if (current.trim().length === 0) return { value: entry, changed: true };
  const separator = current.endsWith(";") ? "" : ";";
  return { value: `${current}${separator}${entry}`, changed: true };
}

/** Removes exactly the matching entry; unrelated entries keep their order. */
export function removeFromUserPath(
  existing: string | undefined,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): PathMutation {
  const current = existing ?? "";
  if (current.length === 0) return { value: current, changed: false };
  const wanted = pathEntryKey(entry, env);
  const parts = current.split(";");
  const kept = parts.filter((part) => pathEntryKey(part, env) !== wanted);
  if (kept.length === parts.length) return { value: current, changed: false };
  return { value: kept.join(";"), changed: true };
}

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  paths?: WindowsInstallPaths;
  registry?: UserEnvironmentRegistry;
  platform?: NodeJS.Platform;
  /** Explicit executable to install; otherwise release/ is discovered. */
  exeFile?: string;
  bundleFile?: string;
  root?: string;
  nodeExecutable?: string;
  log?: (line: string) => void;
}

export interface InstallResult {
  binDir: string;
  installed: "exe" | "bundle";
  launcher: string;
  pathChanged: boolean;
}

interface ChosenArtifact {
  kind: "exe" | "bundle";
  source: string;
}

function chooseArtifact(options: InstallOptions, paths: WindowsInstallPaths): ChosenArtifact {
  const layout = buildLayout(options.root ?? process.cwd());
  const candidates: { kind: "exe" | "bundle"; path: string }[] = [];
  if (options.exeFile !== undefined) candidates.push({ kind: "exe", path: options.exeFile });
  if (options.bundleFile !== undefined) candidates.push({ kind: "bundle", path: options.bundleFile });
  // Running as the installed SEA is the normal path for `carls --install-win`:
  // install the binary the user is actually running, not a release/ directory
  // that happens to exist in the current working directory.
  if (basename(process.execPath).toLowerCase() === "carls.exe") {
    candidates.push({ kind: "exe", path: process.execPath });
  }
  // `node release/carls.bundle.cjs --install-win` has no exe to copy.
  const argvEntry = process.argv[1];
  if (argvEntry !== undefined && basename(argvEntry).toLowerCase() === "carls.bundle.cjs") {
    candidates.push({ kind: "bundle", path: argvEntry });
  }
  candidates.push({ kind: "exe", path: layout.exeFile });
  candidates.push({ kind: "bundle", path: layout.bundleFile });

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return { kind: candidate.kind, source: candidate.path };
  }
  throw new Error(
    "No carls.exe or carls.bundle.cjs found. Run `npm run build:exe` (or `npm run build:bundle`) first.",
  );
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Copies the artifact into `%LOCALAPPDATA%\carls\bin` and makes that directory
 * resolvable from a new terminal. Returns what was done so the CLI can print a
 * precise message (and tests can assert without parsing prose).
 */
export function installWindows(options: InstallOptions = {}): InstallResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("--install-win is only available on Windows.");
  }
  const env = options.env ?? process.env;
  const paths = options.paths ?? windowsInstallPaths(env);
  const registry = options.registry ?? createUserEnvironmentRegistry();
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const artifact = chooseArtifact(options, paths);

  ensureDirectory(paths.binDir);
  let launcher = paths.exeFile;
  if (artifact.kind === "exe") {
    if (pathEntryKey(artifact.source, env) !== pathEntryKey(paths.exeFile, env)) {
      copyFileSync(artifact.source, paths.exeFile);
    }
    // A stale bundle launcher would be invisible until someone ran `carls.cmd`
    // directly, at which point it would execute an older payload.
    rmSync(paths.cmdFile, { force: true });
    rmSync(paths.bundleFile, { force: true });
    launcher = paths.exeFile;
  } else {
    if (pathEntryKey(artifact.source, env) !== pathEntryKey(paths.bundleFile, env)) {
      copyFileSync(artifact.source, paths.bundleFile);
    }
    const node = options.nodeExecutable ?? process.execPath;
    writeFileSync(
      paths.cmdFile,
      `@echo off\r\n"${node}" "%~dp0carls.bundle.cjs" %*\r\n`,
      "utf8",
    );
    // The old exe would win the PATHEXT lookup and keep the previous version.
    rmSync(paths.exeFile, { force: true });
    launcher = paths.cmdFile;
  }

  const existing = registry.read("Path");
  const mutation = addToUserPath(existing?.value, paths.binDir, env);
  if (mutation.changed) {
    registry.write("Path", mutation.value, existing?.kind ?? "REG_EXPAND_SZ");
    const confirmed = registry.read("Path");
    const check = confirmed === undefined ? undefined : addToUserPath(confirmed.value, paths.binDir, env);
    if (check === undefined || check.changed) {
      // Reading back catches a silent failure before the user is told it worked.
      throw new Error(
        "The user Path was written but could not be read back; open a new terminal and check `where carls`.",
      );
    }
  }

  log(`Installed carls to ${paths.binDir}`);
  log(`Launcher: ${launcher}`);
  if (mutation.changed) {
    log(
      `Added ${paths.binDir} to the user Path. Open a new terminal (PowerShell, cmd or Windows Terminal) ` +
        "so that `carls` resolves from any directory.",
    );
  } else {
    log(`${paths.binDir} is already on the user Path; open a new terminal if this one predates it.`);
  }
  return { binDir: paths.binDir, installed: artifact.kind, launcher, pathChanged: mutation.changed };
}

export interface UninstallResult {
  removed: string[];
  pathChanged: boolean;
}

/**
 * Deletes a file after this process releases it. Windows keeps an executing
 * image locked, so `carls.exe --uninstall-win` cannot delete itself; a tiny
 * detached shell waits for the exit and removes it then.
 */
function scheduleDeferredDelete(file: string): void {
  try {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    const command = `ping 127.0.0.1 -n 3 >nul & del /f /q "${file}"`;
    const child = spawn(comspec, ["/d", "/s", "/c", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The next install overwrites the file, so a failed schedule is not fatal.
  }
}

/** Removes the installed files and the exact Path entry, leaving user data alone. */
export function uninstallWindows(options: InstallOptions = {}): UninstallResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("--uninstall-win is only available on Windows.");
  }
  const env = options.env ?? process.env;
  const paths = options.paths ?? windowsInstallPaths(env);
  const registry = options.registry ?? createUserEnvironmentRegistry();
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const removed: string[] = [];
  for (const file of [paths.exeFile, paths.bundleFile, paths.cmdFile]) {
    if (!fileExists(file)) continue;
    try {
      rmSync(file, { force: true });
      removed.push(file);
    } catch {
      scheduleDeferredDelete(file);
      log(`${file} is in use; it will be removed after this process exits.`);
    }
  }

  const existing = registry.read("Path");
  const mutation = removeFromUserPath(existing?.value, paths.binDir, env);
  if (mutation.changed) {
    registry.write("Path", mutation.value, existing?.kind ?? "REG_EXPAND_SZ");
  }

  // Only the bin directory: `%LOCALAPPDATA%\carls` also holds sessions and
  // other user state that an uninstall has no business deleting.
  try {
    if (existsSync(paths.binDir) && readdirSync(paths.binDir).length === 0) {
      rmSync(paths.binDir, { recursive: true, force: true });
    }
  } catch {
    // A non-empty or locked directory is left in place.
  }

  log(
    removed.length > 0
      ? `Removed ${removed.length} file(s) from ${paths.binDir}.`
      : `Nothing to remove from ${paths.binDir}.`,
  );
  log(
    mutation.changed
      ? "Removed the carls bin directory from the user Path. Open a new terminal to pick up the change."
      : "The carls bin directory was not on the user Path.",
  );
  return { removed, pathChanged: mutation.changed };
}

/** Reads the installed version marker, used by `--doctor` and tests. */
export function installedExecutable(paths: WindowsInstallPaths = windowsInstallPaths()): string | undefined {
  for (const file of [paths.exeFile, paths.cmdFile]) {
    if (fileExists(file)) return file;
  }
  return undefined;
}

/** Cheap integrity check: the launcher exists and is non-empty. */
export function validateInstallation(paths: WindowsInstallPaths = windowsInstallPaths()): string | undefined {
  const launcher = installedExecutable(paths);
  if (launcher === undefined) return "carls is not installed for this user";
  try {
    if (statSync(launcher).size === 0) return `${launcher} is empty`;
  } catch (error) {
    return `${launcher} cannot be read: ${(error as Error).message}`;
  }
  return undefined;
}
