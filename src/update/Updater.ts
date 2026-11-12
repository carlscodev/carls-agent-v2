import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AutoUpdateMode } from "../types/update.js";
import { packageVersion } from "../core/Runtime.js";
import { isWindows, userDataDir } from "../utils/platform.js";

/**
 * Release-driven updates.
 *
 * The install is script-based (there is no npm registry entry and no native
 * package), so an update is "re-run the installer for the release tag". That
 * keeps one code path for linux, macOS and Windows: the installer already knows
 * how to install Node, build the tree, write the launcher and keep the config.
 *
 * Everything that decides *what* to run is a pure function (`installerPlan`), so
 * the risky part is testable without executing it.
 */

export const UPDATE_REPO = "BerunHaider/carls-agent-v2";
export const UPDATE_RAW_BASE = `https://raw.githubusercontent.com/${UPDATE_REPO}`;

/** How long a cached release check stays fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 4000;
const SCRIPT_TIMEOUT_MS = 20000;

export interface UpdateCheck {
  current: string;
  /** Normalized release version (no leading v). */
  latest: string;
  /** Release tag as published, which is what the installer needs. */
  tag: string;
  available: boolean;
  url: string;
}

export interface UpdateCheckOptions {
  timeoutMs?: number;
  /** Overrides the GitHub API root; used by tests and mirrored deployments. */
  apiBase?: string;
}

export interface UpdateCache {
  checkedAt: number;
  latest: string;
  tag: string;
  url: string;
  /** Release this install last upgraded to by itself. */
  autoInstalled?: string;
  /** Version whose automatic install failed, so it is never retried blindly. */
  autoFailed?: string;
}

/**
 * Numeric, dot-separated comparison. A pre-release ("1.2.0-rc.1") sorts below
 * its release, which is what makes `carls update --check` honest on a beta tag.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.nums.length, right.nums.length);
  for (let index = 0; index < length; index++) {
    const x = left.nums[index] ?? 0;
    const y = right.nums[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function splitVersion(version: string): { nums: number[]; pre: string } {
  const cleaned = version.trim().replace(/^v/i, "");
  const dash = cleaned.indexOf("-");
  const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const pre = dash === -1 ? "" : cleaned.slice(dash + 1);
  const nums = core
    .split(".")
    .map((part) => Number.parseInt(part.replace(/[^0-9]/g, ""), 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
  return { nums, pre };
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Reads `tag_name` from a GitHub release payload. */
export function releaseFromPayload(payload: unknown): { version: string; tag: string; url: string } | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as { tag_name?: unknown; html_url?: unknown };
  if (typeof record.tag_name !== "string" || record.tag_name.trim().length === 0) return undefined;
  const tag = record.tag_name.trim();
  const url = typeof record.html_url === "string" ? record.html_url : `https://github.com/${UPDATE_REPO}/releases`;
  return { version: normalizeVersion(tag), tag, url };
}

/** Reads the newest tag from a GitHub tags payload (no releases published yet). */
export function tagFromPayload(payload: unknown): { version: string; tag: string; url: string } | undefined {
  if (!Array.isArray(payload)) return undefined;
  const first = payload[0] as { name?: unknown } | undefined;
  if (first === undefined || typeof first.name !== "string" || first.name.trim().length === 0) return undefined;
  const tag = first.name.trim();
  return { version: normalizeVersion(tag), tag, url: `https://github.com/${UPDATE_REPO}/releases/tag/${tag}` };
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "carls-code-updater",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function apiBase(options: UpdateCheckOptions): string {
  return (options.apiBase ?? process.env.CARLS_UPDATE_API ?? `https://api.github.com/repos/${UPDATE_REPO}`).replace(
    /\/$/,
    "",
  );
}

/**
 * Asks GitHub for the latest release, falling back to the newest tag so a repo
 * that publishes tags but no releases still updates.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheck> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const base = apiBase(options);
  const current = packageVersion();

  // A repo that publishes a tag but no Release answers 404 here; that is not a
  // failure, it is the signal to fall back to the tags endpoint.
  let found: ReturnType<typeof releaseFromPayload>;
  try {
    found = releaseFromPayload(await getJson(`${base}/releases/latest`, timeoutMs));
  } catch {
    found = undefined;
  }
  if (found === undefined) {
    found = tagFromPayload(await getJson(`${base}/tags?per_page=1`, timeoutMs));
  }
  if (found === undefined) throw new Error("no release or tag was published for this repository");

  return {
    current,
    latest: found.version,
    tag: found.tag,
    available: compareVersions(found.version, current) > 0,
    url: found.url,
  };
}

export function updateCachePath(): string {
  return join(userDataDir(), "update-check.json");
}

export function readUpdateCache(): UpdateCache | undefined {
  const path = updateCachePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return undefined;
    return {
      checkedAt: parsed.checkedAt,
      latest: parsed.latest,
      tag: typeof parsed.tag === "string" ? parsed.tag : `v${parsed.latest}`,
      url: typeof parsed.url === "string" ? parsed.url : "",
      ...(typeof parsed.autoInstalled === "string" ? { autoInstalled: parsed.autoInstalled } : {}),
      ...(typeof parsed.autoFailed === "string" ? { autoFailed: parsed.autoFailed } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeUpdateCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(updateCachePath()), { recursive: true });
    writeFileSync(updateCachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    // A read-only home must not break a run; the cache is an optimisation.
  }
}

/** Updates only the bookkeeping fields, so a check never erases install state. */
export function patchUpdateCache(patch: Partial<UpdateCache>): void {
  const current = readUpdateCache();
  const base: UpdateCache = current ?? {
    checkedAt: 0,
    latest: packageVersion(),
    tag: `v${packageVersion()}`,
    url: "",
  };
  writeUpdateCache({ ...base, ...patch });
}

/**
 * Whether this release may be installed without being asked.
 *
 * The brakes matter more than the feature: at most one automatic install per
 * release, and a version that already failed once is only ever announced. A
 * crash loop of installers at startup would be far worse than a stale build.
 */
export function shouldAutoUpdate(check: UpdateCheck, cache: UpdateCache | undefined): boolean {
  if (!check.available) return false;
  if (cache === undefined) return true;
  if (cache.autoFailed === check.latest) return false;
  if (cache.autoInstalled === check.latest) return false;
  return true;
}

/**
 * Non-blocking freshness check. One network call per 24h, and an offline or
 * rate-limited result simply keeps the previous answer.
 */
export async function cachedUpdateCheck(options: UpdateCheckOptions = {}): Promise<UpdateCheck> {
  const current = packageVersion();
  const cache = readUpdateCache();
  if (cache !== undefined && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
    return {
      current,
      latest: cache.latest,
      tag: cache.tag,
      available: compareVersions(cache.latest, current) > 0,
      url: cache.url,
    };
  }
  const check = await checkForUpdate(options);
  writeUpdateCache({ checkedAt: Date.now(), latest: check.latest, tag: check.tag, url: check.url });
  return check;
}

/** The one-line notice printed at startup, or undefined when up to date. */
export function updateAnnouncement(check: UpdateCheck): string | undefined {
  if (!check.available) return undefined;
  return (
    `↑ carls ${check.latest} is available (you have ${check.current}). ` +
    `Run "carls update" to install it.`
  );
}

/**
 * Startup update handling, on stderr only, never blocking the prompt.
 *
 * - `auto`: install a newer release in place, once per version.
 * - `notify`: print the one-line notice and do nothing else.
 * - `off`: no check at all.
 */
export async function announceUpdate(mode: AutoUpdateMode = "auto"): Promise<void> {
  if (mode === "off") return;
  if (process.env.CARLS_NO_UPDATE_CHECK === "1") return;
  if (process.stderr.isTTY !== true) return;
  let check: UpdateCheck;
  try {
    check = await cachedUpdateCheck();
  } catch {
    // Offline, proxied, rate-limited: not a problem worth reporting.
    return;
  }
  if (!check.available) return;

  if (mode === "auto" && shouldAutoUpdate(check, readUpdateCache())) {
    process.stderr.write(`↑ carls ${check.current} → ${check.latest}, updating in place\n`);
    const code = await runUpdate({ ref: check.tag, quiet: true });
    if (code === 0) {
      patchUpdateCache({ autoInstalled: check.latest, latest: check.latest, tag: check.tag });
      process.stderr.write(`✓ carls ${check.latest} installed. Restart carls to use it.\n`);
      return;
    }
    patchUpdateCache({ autoFailed: check.latest });
  }

  const line = updateAnnouncement(check);
  if (line !== undefined) process.stderr.write(`${line}\n`);
}

export interface InstallerPlan {
  /** URL of the installer script for the requested tag. */
  url: string;
  /** Local file it is written to before being executed. */
  scriptPath: string;
  command: string;
  args: string[];
}

/**
 * Describes how the target release is installed. The tag is passed down rather
 * than "latest", so an install cannot silently land on a newer (or older) build
 * than the one the user was told about.
 */
export function installerPlan(
  ref: string,
  platform: NodeJS.Platform = process.platform,
  tempDir: string = tmpdir(),
): InstallerPlan {
  const windows = platform === "win32";
  const scriptPath = join(tempDir, windows ? "carls-install.ps1" : "carls-install.sh");
  return {
    url: `${UPDATE_RAW_BASE}/${ref}/scripts/${windows ? "install.ps1" : "install.sh"}`,
    scriptPath,
    command: windows ? "powershell" : "bash",
    args: windows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Yes", "-Ref", ref]
      : [scriptPath, "--yes", "--ref", ref],
  };
}

async function downloadScript(url: string, destination: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "carls-code-updater" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${url}`);
    const body = await response.text();
    if (body.trim().length === 0) throw new Error(`${url} returned an empty installer`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body, { encoding: "utf8", mode: 0o600 });
  } finally {
    clearTimeout(timer);
  }
}

function runScript(command: string, args: string[], quiet = false): Promise<number> {
  return new Promise<number>((resolve) => {
    // A quiet run is an automatic update during startup: the installer's own
    // progress would paint over the prompt, so its output is captured and only
    // the failure tail is shown.
    const child = spawn(command, args, { stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", shell: false });
    if (quiet) {
      let tail = "";
      const collect = (chunk: Buffer): void => {
        tail = (tail + chunk.toString("utf8")).slice(-2000);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", () => resolve(1));
      child.on("close", (code) => {
        const status = code ?? 1;
        if (status !== 0) {
          const lines = tail.trim().split("\n").slice(-8).join("\n");
          if (lines.length > 0) process.stderr.write(`${lines}\n`);
        }
        resolve(status);
      });
      return;
    }
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export interface RunUpdateOptions {
  /** Only report whether a newer release exists. */
  check?: boolean;
  /** Pin the release tag instead of asking GitHub. */
  ref?: string;
  /** Print the plan without downloading or executing anything. */
  dryRun?: boolean;
  /** Keep the installer's output out of the terminal (used by auto-update). */
  quiet?: boolean;
}

/**
 * Entry point for `carls update` and `/update`. Returns a process exit code.
 * Everything user-visible goes to stderr, because stdout belongs to the model.
 */
export async function runUpdate(options: RunUpdateOptions = {}): Promise<number> {
  const quiet = options.quiet === true;
  const out = (line: string): void => {
    if (!quiet) process.stderr.write(`${line}\n`);
  };
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const current = packageVersion();

  let check: UpdateCheck;
  if (options.ref !== undefined && options.ref.length > 0) {
    check = {
      current,
      latest: normalizeVersion(options.ref),
      tag: options.ref,
      available: compareVersions(options.ref, current) > 0,
      url: `https://github.com/${UPDATE_REPO}/releases/tag/${options.ref}`,
    };
  } else {
    try {
      check = await checkForUpdate();
    } catch (error) {
      err(`error: could not check for updates: ${(error as Error).message}`);
      err(`Install the latest build directly with: ${UPDATE_RAW_BASE}/main/scripts/install.sh`);
      return 1;
    }
  }

  if (options.check) {
    out(
      check.available
        ? `carls ${current} → ${check.latest} available (${check.url})`
        : `carls ${current} is up to date (latest ${check.latest}).`,
    );
    return 0;
  }

  if (!check.available) {
    out(`carls ${current} is already the latest release (${check.latest}).`);
    return 0;
  }

  const plan = installerPlan(check.tag, isWindows() ? "win32" : process.platform);
  out(`Updating carls ${current} → ${check.latest} (${check.tag})`);
  out(`${plan.command} ${plan.args.join(" ")}`);
  if (options.dryRun === true) return 0;

  try {
    await downloadScript(plan.url, plan.scriptPath);
  } catch (error) {
    err(`error: could not download the installer: ${(error as Error).message}`);
    err(`Re-run the one-liner from ${UPDATE_RAW_BASE}/main/README.md#install`);
    return 1;
  }

  const code = await runScript(plan.command, plan.args, quiet);
  if (code !== 0) {
    err(`error: the installer exited with code ${code}.`);
    if (isWindows()) {
      err("If Node.js was installed by this run, open a new terminal and run carls update again.");
    } else {
      err("If the install prefix is root-owned, re-run the same command with sudo.");
    }
    return code;
  }

  out(`carls ${check.latest} installed. Restart carls to use it.`);
  writeUpdateCache({ checkedAt: Date.now(), latest: check.latest, tag: check.tag, url: check.url });
  return 0;
}
