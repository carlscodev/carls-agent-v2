import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { complete } from "../src/cli/Autocomplete.js";
import { listWorkspaceFiles } from "../src/cli/Mentions.js";
import { GlobFiles } from "../src/tools/GlobFiles.js";
import { SessionStore } from "../src/core/SessionStore.js";
import type { Runtime } from "../src/core/Runtime.js";
import type { ToolContext } from "../src/types/tools.js";
import { isIgnoredDirName } from "../src/utils/ignoredDirs.js";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
};

let root: string;
let home: string;
let workspace: string;
let sessionsDir: string;
let runtime: Runtime;

async function touch(relativePath: string, content = "x"): Promise<void> {
  const full = join(workspace, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

function restoreEnv(name: "HOME" | "USERPROFILE" | "APPDATA"): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "carls-resume-"));
  home = join(root, "home");
  workspace = join(root, "workspace");
  sessionsDir = join(home, ".carls", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // The home budget and session paths both use os.homedir(): on Windows that
  // is USERPROFILE, on macOS/Linux it is HOME. Set both for the same folder.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");

  const first = new SessionStore(join(home, "project-alpha"), "model-a", "session-alpha", sessionsDir);
  first.recordMessage({ role: "user", content: [{ type: "text", text: "fix the parser" }] });
  first.recordMessage({ role: "assistant", content: [{ type: "text", text: "working" }] });
  // A tool observation is stored as a user-role message; it must not inflate
  // the prompt count or replace the opening prompt.
  first.recordMessage({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-1", content: "line 1", is_error: false }],
  });

  const second = new SessionStore(join(home, "project-beta"), "model-b", "session-beta", sessionsDir);
  second.recordMessage({ role: "user", content: [{ type: "text", text: "second session" }] });
  second.recordMessage({ role: "assistant", content: [{ type: "text", text: "ready" }] });

  runtime = {
    config: { cwd: workspace, provider: "anthropic", model: "test-model", contextWindow: 200000 },
  } as unknown as Runtime;
});

afterEach(async () => {
  restoreEnv("HOME");
  restoreEnv("USERPROFILE");
  restoreEnv("APPDATA");
  await rm(root, { recursive: true, force: true });
});

describe("/resume completion", () => {
  it("offers saved session ids and never workspace paths", () => {
    const result = complete({ line: "/resume ", cursor: "/resume ".length, runtime });
    expect(result).toBeDefined();
    expect(result?.items.length).toBeGreaterThanOrEqual(2);
    expect(result?.items.every((item) => item.kind === "arg")).toBe(true);

    const ids = result?.items.map((item) => item.value) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["session-alpha", "session-beta"]));
    for (const id of ids) {
      expect(id).not.toContain("/");
      expect(id).not.toContain("\\");
      expect(id).not.toContain("AppData");
      expect(id).not.toContain(".dll");
    }

    const alpha = result?.items.find((item) => item.value === "session-alpha");
    expect(alpha?.detail).toContain("~/project-alpha");
    expect(alpha?.detail).toContain('"fix the parser"');
    expect(alpha?.detail).toContain("1 msg");
    expect(alpha?.detail).not.toContain("working");
  });

  it("keeps the first slash token and later arguments out of the file walk", () => {
    const commands = complete({ line: "/res", cursor: 4, runtime });
    expect(commands?.items.every((item) => item.kind === "command")).toBe(true);
    expect(commands?.items.map((item) => item.value)).toContain("/resume");

    // A second argument to /resume is free-form; it must not fall back to files.
    const withId = "/resume session-alpha ";
    expect(complete({ line: withId, cursor: withId.length, runtime })).toBeUndefined();
    // A non-@ path token is text, not a mention.
    const plainPath = "please check src/";
    expect(complete({ line: plainPath, cursor: plainPath.length, runtime })).toBeUndefined();
    const mention = "please @src/";
    expect(complete({ line: mention, cursor: mention.length, runtime })).toBeUndefined();
  });
});

describe("workspace file indexing", () => {
  it("ignores AppData, Windows, Program Files and profile hives", async () => {
    await touch("src/main.ts");
    await touch("src/nested/deep.ts");
    await touch(".github/workflows/ci.yml");
    await touch("AppData/Local/Microsoft/foo.dll");
    await touch("Windows/System32/bar.exe");
    await touch("Program Files (x86)/App/installer.exe");
    await touch("node_modules/pkg/index.js");
    await touch(".cache/blob.bin");
    await touch("Library/Caches/blob.bin");
    await touch("NTUSER.DAT");
    await touch("src/keep.dll");

    const files = listWorkspaceFiles(workspace);
    expect(files).toEqual([
      ".github/workflows/ci.yml",
      "src/keep.dll",
      "src/main.ts",
      "src/nested/deep.ts",
    ]);
    expect(files.some((file) => /AppData|Windows|Program Files|NTUSER|node_modules/i.test(file))).toBe(false);

    const tool = new GlobFiles();
    const result = await tool.run(
      { pattern: "**/*.dll", limit: 50 },
      { cwd: workspace } as ToolContext,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/keep.dll");
    expect(result.output).not.toMatch(/AppData|Program Files/i);

    expect(isIgnoredDirName("AppData")).toBe(true);
    expect(isIgnoredDirName("appdata")).toBe(true);
    expect(isIgnoredDirName("NTUSER.DAT")).toBe(true);
    expect(isIgnoredDirName("src")).toBe(false);
  });

  it("caps a home-directory cwd to a shallow walk", async () => {
    await touch("top.ts");
    await touch("src/nested/deep.ts");
    await touch("deep/a/b/inside.ts");
    await touch("AppData/Local/foo.dll");

    // Make the workspace itself the home directory for both helpers.
    process.env.HOME = workspace;
    process.env.USERPROFILE = workspace;

    const files = listWorkspaceFiles(workspace);
    expect(files).toContain("top.ts");
    expect(files).toContain("src/nested/deep.ts");
    expect(files).not.toContain("deep/a/b/inside.ts");
    expect(files.length).toBeLessThanOrEqual(200);
    expect(files.some((file) => file.includes("AppData"))).toBe(false);

    const tool = new GlobFiles();
    const result = await tool.run(
      { pattern: "**/*.ts", limit: 1000 },
      { cwd: workspace } as ToolContext,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("top.ts");
    expect(result.output).not.toContain("deep/a/b/inside.ts");
    expect(result.output).not.toContain("AppData");
  });
});
