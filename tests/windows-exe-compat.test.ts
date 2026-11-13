import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SEA_BLOB_RESOURCE_NAME,
  SEA_FUSE_PREFIX,
  buildBundle,
  buildLayout,
  buildResourceSection,
  createSeaConfig,
  findSeaFuseOffset,
  injectSeaBlob,
  parseResourceTree,
  readBuiltinSkillSources,
  readPackageVersion,
  stripAuthenticode,
  writeSeaConfig,
  type BuildLayout,
  type BundleArtifact,
} from "../src/os/WindowsNativeBuild.js";
import {
  CONSOLE_RESTORE_SEQUENCE,
  normalizeWindowsLongPath,
  planDirectWindowsCommand,
  resolveWindowsExecutable,
  restoreConsoleState,
  splitSimpleCommandLine,
  toExtendedLengthPath,
  utf8PreludeForShell,
  windowsPathExt,
  windowsUtf8Environment,
} from "../src/os/WindowsCompat.js";
import { normalizeWindowsPath, windowsPathKey } from "../src/os/WindowsCompat.js";
import { normalizeWorkspacePath } from "../src/os/OsRuntimeAdapter.js";
import { FileStateCache } from "../src/core/FileStateCache.js";
import {
  addToUserPath,
  installWindows,
  removeFromUserPath,
  uninstallWindows,
  validateInstallation,
  windowsInstallPaths,
  type UserEnvironmentRegistry,
} from "../src/os/WindowsInstall.js";
import { ArgError, HELP_TEXT, parseArgs } from "../src/cli/ArgsParser.js";

const root = process.cwd();
const temporaryDirs: string[] = [];

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function retargetedLayout(releaseDir: string): BuildLayout {
  const base = buildLayout(root);
  return {
    ...base,
    releaseDir,
    bundleFile: join(releaseDir, "carls.bundle.cjs"),
    seaConfigFile: join(releaseDir, "sea-config.json"),
    blobFile: join(releaseDir, "sea-prep.blob"),
    exeFile: join(releaseDir, "carls.exe"),
    cmdFile: join(releaseDir, "carls.cmd"),
  };
}

afterAll(async () => {
  for (const dir of temporaryDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("SEA configuration", () => {
  it("writes the exact single-executable config", async () => {
    const dir = await temporaryDir("carls-sea-");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "carls-code", version: "0.0.0" }));
    const layout = buildLayout(dir);
    const config = writeSeaConfig(layout);

    expect(config).toEqual({
      main: "release/carls.bundle.cjs",
      output: "release/sea-prep.blob",
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
    });
    expect(createSeaConfig(buildLayout(root))).toEqual({
      main: "release/carls.bundle.cjs",
      output: "release/sea-prep.blob",
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
    });

    const text = await readFile(layout.seaConfigFile, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(config);
  });

  it("embeds the builtin skills and the package version", () => {
    const skills = readBuiltinSkillSources(root);
    expect(Object.keys(skills).length).toBeGreaterThan(20);
    const config = skills["carls-code-config/SKILL.md"];
    expect(config).toBeDefined();
    expect(config).toContain("description:");
    expect(readPackageVersion(root)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("single-file bundle", () => {
  let dir: string;
  let layout: BuildLayout;
  let artifact: BundleArtifact;

  beforeAll(async () => {
    dir = await temporaryDir("carls-bundle-");
    layout = retargetedLayout(join(dir, "release"));
    artifact = await buildBundle(layout, { entry: join(root, "src", "index.ts") });
  }, 180_000);

  it("bundles every runtime dependency and no external package require", async () => {
    const text = await readFile(layout.bundleFile, "utf8");
    for (const dependency of ["zod", "globby", "picocolors", "@anthropic-ai/sdk"]) {
      expect(artifact.inputs.some((input) => input.includes(`node_modules/${dependency}/`))).toBe(true);
    }
    expect(text).not.toMatch(/require\(["'](?:zod|globby|picocolors|@anthropic-ai\/sdk)["']\)/);
    expect(text).toContain("carls-code-config/SKILL.md");
    expect(artifact.bytes).toBeGreaterThan(100_000);
  }, 60_000);

  it("runs --version and --help from the bundle alone", () => {
    const version = spawnSync(process.execPath, [layout.bundleFile, "--version"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(readPackageVersion(root));

    const help = spawnSync(process.execPath, [layout.bundleFile, "--help"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("USAGE");
    expect(help.stdout).toContain("--install-win");
  }, 120_000);

  it("is deterministic across builds", async () => {
    const repeat = retargetedLayout(join(dir, "release-repeat"));
    await buildBundle(repeat, { entry: join(root, "src", "index.ts") });
    const digest = (file: string): string =>
      createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(digest(layout.bundleFile)).toBe(digest(repeat.bundleFile));
  }, 180_000);
});

describe("Windows resource and PE helpers", () => {
  it("rebuilds the resource tree with the SEA blob and is idempotent", () => {
    const firstBlob = Buffer.from("first-payload");
    const first = buildResourceSection(Buffer.alloc(0), firstBlob, 0x1000, 0);
    expect(first.rootOffset).toBe(0);

    const parsed = parseResourceTree(first.section);
    const typeTen = parsed.ids.find((entry) => entry.name.kind === "id" && entry.name.id === 10);
    expect(typeTen).toBeDefined();
    expect(typeTen?.child?.named[0]?.name).toEqual({ kind: "string", value: SEA_BLOB_RESOURCE_NAME });

    const secondBlob = Buffer.from("second-payload");
    const second = buildResourceSection(first.section, secondBlob, 0x5000, 0x1000);
    const reparsed = parseResourceTree(second.section);
    expect(reparsed.ids.filter((entry) => entry.name.kind === "id" && entry.name.id === 10)).toHaveLength(1);
    const sea = repairedSeaData(reparsed);
    expect(sea?.rva).toBeGreaterThanOrEqual(0x5000);
    expect(sea?.size).toBe(secondBlob.length);
  });

  it.runIf(process.platform === "win32")(
    "injects into node.exe, patches the fuse and keeps the manifest",
    () => {
      const executable = readFileSync(process.execPath);
      const blob = Buffer.from("carls-sea-test-payload");
      const injected = injectSeaBlob(executable, blob);
      expect(injected.buffer.length).toBeGreaterThan(executable.length);
      expect(injected.fusePatched).toBe(true);

      const fuse = findSeaFuseOffset(injected.buffer);
      expect(fuse).toBeGreaterThan(0);
      expect(injected.buffer.toString("latin1", fuse, fuse + SEA_FUSE_PREFIX.length)).toBe(
        SEA_FUSE_PREFIX,
      );
      expect(injected.buffer[fuse + SEA_FUSE_PREFIX.length + 1]).toBe(0x31);
      expect(injected.buffer.includes(Buffer.from("<assembly", "utf8"))).toBe(true);
      expect(injected.buffer.includes(Buffer.from(SEA_BLOB_RESOURCE_NAME, "utf16le"))).toBe(true);
      expect(injected.buffer.includes(Buffer.from(".rsrc2", "latin1"))).toBe(true);
    },
    120_000,
  );

  it.runIf(process.platform === "win32")("strips an Authenticode certificate table", () => {
    const executable = readFileSync(process.execPath);
    const stripped = stripAuthenticode(executable);
    if (stripped.stripped) expect(stripped.buffer.length).toBeLessThan(executable.length);
  });
});

function repairedSeaData(tree: ReturnType<typeof parseResourceTree>) {
  const typeTen = tree.ids.find((entry) => entry.name.kind === "id" && entry.name.id === 10);
  const name = typeTen?.child?.named[0];
  return name?.child?.ids[0]?.data;
}

describe("Windows path compatibility", () => {
  it("gives every drive spelling one key", () => {
    expect(windowsPathKey("c:\\proyecto\\a.ts")).toBe(windowsPathKey("C:\\Proyecto\\A.TS"));
    expect(normalizeWindowsPath("c:/proyecto/a.ts")).toBe("C:\\proyecto\\a.ts");
    expect(normalizeWorkspacePath("src/a.ts", "c:\\work\\project", { platform: "win32" })).toBe(
      "C:\\work\\project\\src\\a.ts",
    );
    // Git Bash's drive form must resolve to the same native path.
    expect(normalizeWorkspacePath("/c/proyecto/a.ts", "C:\\work", { platform: "win32" })).toBe(
      "C:\\proyecto\\a.ts",
    );
  });

  it.runIf(process.platform === "win32")("uses one FileStateCache entry for c:\\ and C:\\", () => {
    const cache = new FileStateCache();
    cache.put("c:\\proyecto\\a.ts", {
      file: "a.ts",
      mtimeMs: 1,
      size: 10,
      contentHash: "hash",
      symbols: [],
      imports: [],
      lines: 1,
    });
    expect(cache.get("C:\\proyecto\\a.ts")).toBeDefined();
    expect(cache.invalidate("C:\\Proyecto\\a.ts")).toBe(true);
  });

  it("adds the extended prefix for long absolute paths only", () => {
    const long = `C:\\${"a".repeat(300)}\\file.ts`;
    expect(normalizeWindowsLongPath(long).startsWith("\\\\?\\C:\\")).toBe(true);
    expect(normalizeWindowsLongPath("C:\\short\\file.ts")).toBe("C:\\short\\file.ts");
    expect(toExtendedLengthPath(long).startsWith("\\\\?\\C:\\")).toBe(true);
    expect(toExtendedLengthPath("\\\\server\\share\\file.ts")).toBe(
      "\\\\?\\UNC\\server\\share\\file.ts",
    );
  });
});

describe("PATHEXT and direct execution", () => {
  const files = new Set(
    [
      "C:\\tools\\tool.EXE",
      "C:\\tools\\tool.CMD",
      "C:\\tools\\only.CMD",
      "C:\\tools\\script.PS1",
      "C:\\tools\\com.COM",
      "C:\\work\\git.exe",
    ].map((file) => file.toLowerCase()),
  );
  const isFile = (path: string): boolean => files.has(path.toLowerCase());
  const env = {
    PATH: "C:\\Windows\\System32;C:\\tools",
    PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
  };

  it("resolves PATHEXT in order and classifies the launcher", () => {
    const resolved = resolveWindowsExecutable("tool", { env, platform: "win32", isFile });
    expect(resolved?.file.toLowerCase()).toBe("c:\\tools\\tool.exe");
    expect(resolved?.launcher).toBe("direct");
    expect(resolved?.extension).toBe(".EXE");

    expect(resolveWindowsExecutable("only", { env, platform: "win32", isFile })?.launcher).toBe("cmd");
    expect(resolveWindowsExecutable("script", { env, platform: "win32", isFile })?.launcher).toBe(
      "powershell",
    );
    expect(windowsPathExt({ PATHEXT: ".exe;;.CMD" })).toEqual([".EXE", ".CMD"]);
  });

  it("never searches the current directory for a bare name", () => {
    const resolved = resolveWindowsExecutable("git", {
      env: { PATH: "C:\\Windows;;.", PATHEXT: ".EXE" },
      platform: "win32",
      isFile,
      cwd: "C:\\work",
    });
    expect(resolved).toBeUndefined();
    // An explicit path is a deliberate request and still resolves.
    expect(
      resolveWindowsExecutable("C:\\work\\git", {
        env,
        platform: "win32",
        isFile,
      })?.file.toLowerCase(),
    ).toBe("c:\\work\\git.exe");
  });

  it("only plans shell-free execution when the meaning cannot change", () => {
    const env = { PATH: "C:\\Windows\\System32", PATHEXT: ".EXE" };
    const isFile = (path: string): boolean => path.toLowerCase() === "c:\\windows\\system32\\git.exe";
    const plan = planDirectWindowsCommand("git status --short", {
      env,
      platform: "win32",
      isFile,
    });
    expect(plan?.launcher).toBe("direct");
    expect(plan?.args).toEqual(["status", "--short"]);
    expect(
      planDirectWindowsCommand("git status | findstr x", { env, platform: "win32", isFile }),
    ).toBeUndefined();
    expect(
      planDirectWindowsCommand("git commit -m 'message'", { env, platform: "win32", isFile }),
    ).toBeUndefined();
    // A shell must keep the platform-shell path so the UTF-8 prelude is applied.
    expect(
      planDirectWindowsCommand("powershell.exe -Command Write-Output", {
        env,
        platform: "win32",
        isFile: (path) => path.toLowerCase() === "c:\\windows\\system32\\powershell.exe",
      }),
    ).toBeUndefined();
    expect(splitSimpleCommandLine("git status --short")).toEqual(["git", "status", "--short"]);
    expect(splitSimpleCommandLine("git status | findstr x")).toBeUndefined();
    expect(splitSimpleCommandLine("git commit -m 'message'")).toBeUndefined();
    expect(splitSimpleCommandLine('node "C:\\a b\\x.js" --flag')).toEqual([
      "node",
      "C:\\a b\\x.js",
      "--flag",
    ]);
  });

  it("switches PowerShell and cmd to UTF-8", () => {
    expect(utf8PreludeForShell("powershell.exe")).toContain("[Console]::OutputEncoding");
    expect(utf8PreludeForShell("pwsh.exe")).toContain("$OutputEncoding");
    expect(utf8PreludeForShell("cmd.exe")).toContain("chcp 65001");
    expect(utf8PreludeForShell("bash")).toBe("");
    const env = windowsUtf8Environment({ PATH: "x" });
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it.runIf(process.platform === "win32")(
    "captures accents, ñ and box-drawing glyphs from a Windows child",
    () => {
      const command = `${utf8PreludeForShell("powershell.exe")}Write-Output "acentuación ñ ─ │"; exit 0`;
      const result = spawnSync(
        "powershell.exe",
        ["-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          encoding: "utf8",
          env: windowsUtf8Environment(process.env),
          timeout: 60_000,
          windowsHide: true,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("acentuación ñ ─ │");
      expect(result.stderr).toBe("");
    },
    90_000,
  );
});

describe("console restoration", () => {
  it("writes the cursor and sync-mode resets only to a TTY", () => {
    const writes: string[] = [];
    expect(
      restoreConsoleState({ isTTY: true, write: (chunk: string) => writes.push(chunk) }),
    ).toBe(true);
    expect(writes.join("")).toBe(CONSOLE_RESTORE_SEQUENCE);
    expect(writes.join("")).toContain("\u001b[?25h");
    expect(writes.join("")).toContain("\u001b[?2026l");

    const suppressed: string[] = [];
    expect(
      restoreConsoleState({ isTTY: false, write: (chunk: string) => suppressed.push(chunk) }),
    ).toBe(false);
    expect(suppressed).toHaveLength(0);
  });
});

describe("user install", () => {
  function fakeRegistry(initial?: { value: string; kind: "REG_SZ" | "REG_EXPAND_SZ" }) {
    const state: { value: string | undefined; kind: "REG_SZ" | "REG_EXPAND_SZ"; writes: number } = {
      value: initial?.value,
      kind: initial?.kind ?? "REG_EXPAND_SZ",
      writes: 0,
    };
    const registry: UserEnvironmentRegistry = {
      read: () =>
        state.value === undefined ? undefined : { value: state.value, kind: state.kind },
      write: (_name, value, kind) => {
        state.value = value;
        state.kind = kind;
        state.writes++;
      },
    };
    return { state, registry };
  }

  it("appends, de-duplicates and removes one Path entry without truncating", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    const bin = windowsInstallPaths(env).binDir;
    const existing = "C:\\Windows;C:\\Program Files\\Git\\cmd";
    const added = addToUserPath(existing, bin, env);
    expect(added.changed).toBe(true);
    expect(added.value.startsWith(`${existing};`)).toBe(true);
    expect(added.value).toContain(bin);

    const again = addToUserPath(added.value, `${bin}\\`, env);
    expect(again.changed).toBe(false);
    expect(again.value).toBe(added.value);

    const percent = addToUserPath("%LOCALAPPDATA%\\carls\\bin", bin, env);
    expect(percent.changed).toBe(false);

    const removed = removeFromUserPath(added.value, bin, env);
    expect(removed.value.startsWith(existing)).toBe(true);
    expect(removed.value.includes(bin)).toBe(false);
    expect(removed.value).not.toContain(";;");
  });

  it("installs an exe, adds the Path once, and uninstalls cleanly", async () => {
    const dir = await temporaryDir("carls-install-");
    const env = { LOCALAPPDATA: dir };
    const paths = windowsInstallPaths(env);
    const source = join(dir, "carls-source.exe");
    await writeFile(source, "MZ installed payload");
    const { state, registry } = fakeRegistry({
      value: "C:\\Windows;C:\\Tools",
      kind: "REG_EXPAND_SZ",
    });
    const logs: string[] = [];

    const first = installWindows({
      env,
      registry,
      platform: "win32",
      exeFile: source,
      log: (line) => logs.push(line),
    });
    expect(first.installed).toBe("exe");
    expect(await readFile(paths.exeFile, "utf8")).toBe("MZ installed payload");
    expect(state.value?.startsWith("C:\\Windows;C:\\Tools;")).toBe(true);
    expect(state.value?.includes(paths.binDir)).toBe(true);
    expect(first.pathChanged).toBe(true);
    expect(validateInstallation(paths)).toBeUndefined();
    expect(logs.join("\n")).toContain("Open a new terminal");

    const second = installWindows({
      env,
      registry,
      platform: "win32",
      exeFile: source,
      log: () => undefined,
    });
    expect(second.pathChanged).toBe(false);
    expect(state.writes).toBe(1);

    const removed = uninstallWindows({ env, registry, platform: "win32", log: () => undefined });
    expect(removed.removed.length).toBeGreaterThan(0);
    expect(state.value).toBe("C:\\Windows;C:\\Tools");
    await expect(stat(paths.exeFile)).rejects.toThrow();
    expect(validateInstallation(paths)).toContain("not installed");
  }, 30_000);

  it("installs a bundle with a fast cmd launcher when no exe exists", async () => {
    const dir = await temporaryDir("carls-install-bundle-");
    const env = { LOCALAPPDATA: dir };
    const paths = windowsInstallPaths(env);
    const bundle = join(dir, "carls.bundle.cjs");
    await writeFile(bundle, "// bundle");
    const { state, registry } = fakeRegistry();
    const result = installWindows({
      env,
      registry,
      platform: "win32",
      bundleFile: bundle,
      root: join(dir, "missing-root"),
      nodeExecutable: "C:\\node\\node.exe",
      log: () => undefined,
    });
    expect(result.installed).toBe("bundle");
    expect(await readFile(paths.cmdFile, "utf8")).toContain("carls.bundle.cjs");
    expect(await readFile(paths.cmdFile, "utf8")).toContain("C:\\node\\node.exe");
    expect(state.value).toContain(paths.binDir);
  }, 30_000);

  it("refuses to install on a non-Windows host", () => {
    const { registry } = fakeRegistry();
    expect(() =>
      installWindows({ platform: "linux", env: {}, registry, log: () => undefined }),
    ).toThrow(/only available on Windows/);
  });
});

describe("CLI flags", () => {
  it("parses the Windows installer switches", () => {
    expect(parseArgs(["--install-win"]).installWin).toBe(true);
    expect(parseArgs(["--uninstall-win"]).uninstallWin).toBe(true);
    expect(() => parseArgs(["--install-win", "--uninstall-win"])).toThrow(ArgError);
    expect(HELP_TEXT).toContain("--install-win");
    expect(HELP_TEXT).toContain("--uninstall-win");
  });
});
