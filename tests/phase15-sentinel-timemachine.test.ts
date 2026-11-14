import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ProcessSentinel, processLabel } from "../src/core/ProcessSentinel.js";
import { renderServerBadge } from "../src/cli/StatusHud.js";
import { ShadowGit } from "../src/security/ShadowGit.js";
import { setTheme, Theme } from "../src/cli/Theme.js";

const delay = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    setTimeout(() => finish(true), 500);
  });
}

describe("Phase 15 ProcessSentinel", () => {
  it("starts a real HTTP server, detects its port, captures logs and kills it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carls-sentinel-"));
    const script = join(dir, "server.cjs");
    await writeFile(
      script,
      [
        'const http = require("node:http");',
        "const server = http.createServer((_req, res) => res.end('ok'));",
        'server.listen(0, "127.0.0.1", () => {',
        "  const { port } = server.address();",
        '  console.error("Error: simulated stderr line");',
        "  console.log(`http://127.0.0.1:${port}`);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const plain = (text: string | undefined): string => (text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
    const sentinel = new ProcessSentinel({ cwd: dir, ringSize: 200 });
    const startedAt = Date.now();
    try {
      const process = await sentinel.start(`node "${script}"`, { name: "demo", waitForPortMs: 2500 });
      const elapsed = Date.now() - startedAt;

      expect(process.status).toBe("ready");
      expect(process.pid).toBeGreaterThan(0);
      expect(process.port).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(3000);
      expect(process.output.join("\n")).toContain("http://127.0.0.1:");

      // stderr can land a tick after the port; wait for the error counter.
      await waitFor(() => (sentinel.find(process.id)?.errorCount ?? 0) > 0);
      const logs = sentinel.logs(process.id, 20).join("\n");
      expect(logs).toContain("Error: simulated stderr line");
      expect(sentinel.find(process.id)?.errorCount).toBeGreaterThan(0);
      expect(processLabel(sentinel.find(process.id)!)).toContain("demo");

      const stopped = await sentinel.stop(process.id);
      expect(stopped.ok).toBe(true);
      expect(await portIsFree(process.port!)).toBe(true);
      expect(sentinel.activeCount).toBe(0);

      // The badge is a pure function of the last state; check both colours.
      setTheme(new Theme("dark", 24));
      const healthy = renderServerBadge([
        {
          id: "bg-1",
          name: "demo",
          command: "node",
          pid: 1,
          status: "ready",
          port: 5173,
          startedAt: new Date().toISOString(),
          output: [],
          errorCount: 0,
        },
      ]);
      expect(plain(healthy)).toContain("SRV::5173");
      expect(healthy).toContain("●");
      expect(healthy).toContain("38;2;0;255;136");

      const broken = renderServerBadge([
        {
          id: "bg-2",
          name: "demo",
          command: "node",
          pid: 2,
          status: "ready",
          port: 5173,
          startedAt: new Date().toISOString(),
          output: [],
          errorCount: 2,
        },
      ]);
      expect(plain(broken)).toContain("SRV::5173");
      expect(broken).not.toBe(healthy);
    } finally {
      await sentinel.disposeAll();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("Phase 15 ShadowGit TimeMachine", () => {
  it("undoes to A and redoes to B without losing a line, with timeline stats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carls-timemachine-"));
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git(["init", "-q", "."]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      await writeFile(join(dir, "a.txt"), "one\n", "utf8");

      const shadow = new ShadowGit(dir);
      const a = shadow.create("A");
      expect(a).toBeDefined();

      await writeFile(join(dir, "a.txt"), "two\n", "utf8");
      await writeFile(join(dir, "c.txt"), "new\n", "utf8");
      const b = shadow.create("B");
      expect(b).toBeDefined();
      expect(b?.insertions).toBeGreaterThanOrEqual(2);
      expect(b?.deletions).toBeGreaterThanOrEqual(1);
      expect(b?.filesChanged).toBeGreaterThanOrEqual(2);
      expect(shadow.undoDepth).toBe(1);

      const undone = shadow.undo();
      expect(undone?.checkpoint.id).toBe(a?.id);
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
      expect(existsSync(join(dir, "c.txt"))).toBe(false);
      expect(shadow.undoDepth).toBe(0);
      expect(shadow.redoDepth).toBe(1);

      const redone = shadow.redo();
      expect(redone?.checkpoint.id).toBe(b?.id);
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("two\n");
      expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("new\n");
      expect(shadow.redoDepth).toBe(0);

      const timeline = shadow.timeline();
      expect(timeline.length).toBeGreaterThanOrEqual(2);
      const current = timeline.find((entry) => entry.direction === "current");
      expect(current?.id).toBe(b?.id);
      const previous = timeline.find((entry) => entry.id === a?.id);
      expect(previous?.direction).toBe("undo");
      expect(previous?.insertions).toBeGreaterThan(0);
      expect(previous?.deletions).toBe(0);

      shadow.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
