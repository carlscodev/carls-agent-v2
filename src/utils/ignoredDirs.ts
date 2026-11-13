/**
 * Directories that never belong in a workspace-oriented listing.
 *
 * The same names feed the `@file` picker, the fallback walk and the
 * `glob_files` tool. A home directory used as a cwd contains AppData, Windows,
 * Program Files and the NTUSER registry hives; walking those produces thousands
 * of irrelevant DLLs and makes a completion menu feel frozen.
 */

export const IGNORED_DIR_NAMES = [
  // Build and dependency output.
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  // Windows system and per-user profile directories.
  "AppData",
  "Application Data",
  "Local Settings",
  "$Recycle.Bin",
  "System Volume Information",
  "Windows",
  "Program Files",
  "Program Files (x86)",
  ".vscode",
  ".cursor",
  ".carls",
  ".cache",
  // macOS home directories that are never project source.
  "Library",
] as const;

const LOWER_CASE_NAMES = new Set<string>(IGNORED_DIR_NAMES.map((name) => name.toLowerCase()));

/** Case-insensitive so `appdata` and `AppData` both stay out on Windows. */
export function isIgnoredDirName(name: string): boolean {
  return LOWER_CASE_NAMES.has(name.toLowerCase()) || /^ntuser/i.test(name);
}

/**
 * Globby-style exclusions for the tool path. NTUSER files are files without an
 * extension suffix, so the pattern targets the directory entries directly.
 */
export const IGNORED_GLOB_PATTERNS: readonly string[] = [
  ...IGNORED_DIR_NAMES.map((name) => `**/${name}/**`),
  "**/NTUSER*/**",
];
