import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackupStore } from "../src/core/Backups.js";
import { TransactionManager } from "../src/core/TransactionManager.js";
import type { TransactionOutcome } from "../src/core/TransactionManager.js";
import { LspSessionPool } from "../src/lsp/SessionPool.js";
import { ShadowGit } from "../src/security/ShadowGit.js";

let root: string;
const created: string[] = [];

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "carls-txm-"));
  created.push(dir);
  git(["init", "-q", "."], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

async function makePlain(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "carls-txp-"));
  created.push(dir);
  return dir;
}

beforeEach(async () => {
  root = await makeRepo();
});

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A manager with no language server configured, so the command half decides the
 * outcome. `outcomes` maps a command to its exit status.
 */
function manager(
  dir: string,
  outcomes: Record<string, boolean> = {},
  hooks: { onRollback?: (outcome: TransactionOutcome) => void; run?: (command: string) => boolean } = {},
): TransactionManager {
  return new TransactionManager({
    shadowGit: new ShadowGit(dir),
    backups: new BackupStore("tx-test", join(dir, ".carls-backups")),
    lsp: new LspSessionPool({ servers: undefined, cwd: dir }),
    defaultTimeoutMs: 5000,
    runCommand: async (command) => {
      const ok = hooks.run !== undefined ? hooks.run(command) : outcomes[command] === true;
      return { command, ok, output: ok ? "ok" : "failed" };
    },
    ...(hooks.onRollback !== undefined ? { onRollback: hooks.onRollback } : {}),
  });
}

describe("transaction commit", () => {
  it("keeps the change when verification passes", async () => {
    const tx = manager(root, { "verify pass": true });
    const outcome = await tx.run(
      { label: "good edit", files: [join(root, "a.ts")], commands: [{ command: "verify pass" }] },
      async () => {
        await writeFile(join(root, "a.ts"), "export const a = 42;\n", "utf8");
      },
    );

    expect(outcome.committed).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.snapshot).toBe("shadow-git");
    expect(await readFile(join(root, "a.ts"), "utf8")).toContain("42");
  });

  it("commits with no commands and no language server (LSP-only, nothing to check)", async () => {
    const tx = manager(root);
    const outcome = await tx.run({ label: "silent edit", files: [join(root, "a.ts")] }, async () => {
      await writeFile(join(root, "a.ts"), "export const a = 7;\n", "utf8");
    });
    expect(outcome.committed).toBe(true);
    expect(outcome.verification?.problems).toEqual([]);
  });

  it("runs every verification command and reports the failing ones", async () => {
    const tx = manager(root, { "first pass": true, "second fail": false });
    const outcome = await tx.run(
      {
        label: "two commands",
        files: [join(root, "a.ts")],
        commands: [{ command: "first pass" }, { command: "second fail" }],
      },
      async () => {
        await writeFile(join(root, "a.ts"), "export const a = 2;\n", "utf8");
      },
    );

    expect(outcome.committed).toBe(false);
    expect(outcome.verification?.commands.map((c) => c.command)).toEqual(["first pass", "second fail"]);
    expect(outcome.verification?.problems).toContain("second fail failed");
  });
});

describe("transaction rollback", () => {
  it("rolls the whole tree back when a command fails", async () => {
    const tx = manager(root, { "verify fail": false });
    const outcome = await tx.run(
      { label: "bad edit", files: [join(root, "a.ts")], commands: [{ command: "verify fail" }] },
      async () => {
        await writeFile(join(root, "a.ts"), "BROKEN (((\n", "utf8");
        await writeFile(join(root, "added-later.ts"), "junk\n", "utf8");
      },
    );

    expect(outcome.committed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(root, "added-later.ts"))).toBe(false);
    expect(outcome.failedHypothesis).toBe("bad edit");
  });

  it("rolls back when the change itself throws before verification", async () => {
    const tx = manager(root);
    const outcome = await tx.run({ label: "throwing edit", files: [join(root, "a.ts")] }, async () => {
      await writeFile(join(root, "a.ts"), "half written\n", "utf8");
      throw new Error("the tool died mid-edit");
    });

    expect(outcome.committed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.reason).toContain("failed before verification");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("calls onRollback exactly once per failed transaction", async () => {
    const seen: TransactionOutcome[] = [];
    const tx = manager(root, { "verify fail": false }, { onRollback: (o) => seen.push(o) });
    await tx.run(
      { label: "bad", files: [join(root, "a.ts")], commands: [{ command: "verify fail" }] },
      async () => {
        await writeFile(join(root, "a.ts"), "BROKEN\n", "utf8");
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.committed).toBe(false);
  });
});

describe("backups fallback (no repository)", () => {
  it("snapshots every file and restores them when the workspace is not a repository", async () => {
    const plain = await makePlain();
    await writeFile(join(plain, "keep.ts"), "export const original = true;\n", "utf8");
    const tx = manager(plain, { "verify fail": false });

    const outcome = await tx.run(
      {
        label: "edit without git",
        files: [join(plain, "keep.ts")],
        commands: [{ command: "verify fail" }],
      },
      async () => {
        await writeFile(join(plain, "keep.ts"), "DESTROYED\n", "utf8");
      },
    );

    expect(outcome.snapshot).toBe("backups");
    expect(outcome.rolledBack).toBe(true);
    expect(await readFile(join(plain, "keep.ts"), "utf8")).toContain("original = true");
  });

  it("removes a file that did not exist before the batch", async () => {
    const plain = await makePlain();
    await writeFile(join(plain, "existing.ts"), "before\n", "utf8");
    const tx = manager(plain, { "verify fail": false });

    const outcome = await tx.run(
      {
        label: "create a file",
        files: [join(plain, "existing.ts"), join(plain, "brand-new.ts")],
        commands: [{ command: "verify fail" }],
      },
      async () => {
        await writeFile(join(plain, "existing.ts"), "after\n", "utf8");
        await writeFile(join(plain, "brand-new.ts"), "new\n", "utf8");
      },
    );

    expect(outcome.rolledBack).toBe(true);
    expect(await readFile(join(plain, "existing.ts"), "utf8")).toBe("before\n");
    expect(existsSync(join(plain, "brand-new.ts"))).toBe(false);
  });

  it("reports snapshot \"none\" when there is nothing to copy", async () => {
    const plain = await makePlain();
    const tx = manager(plain);
    const outcome = await tx.run({ label: "no files", files: [] }, async () => {});
    expect(outcome.snapshot).toBe("none");
    expect(outcome.committed).toBe(true);
  });
});

describe("backup store integrity", () => {
  it("gives two same-basename files distinct copies even in the same millisecond", async () => {
    const plain = await makePlain();
    await mkdir(join(plain, "a"), { recursive: true });
    await mkdir(join(plain, "b"), { recursive: true });
    const fileA = join(plain, "a", "index.ts");
    const fileB = join(plain, "b", "index.ts");
    await writeFile(fileA, "CONTENT-A\n", "utf8");
    await writeFile(fileB, "CONTENT-B\n", "utf8");

    const store = new BackupStore("collide", join(plain, ".backups"));
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    let entryA;
    let entryB;
    try {
      entryA = store.save(fileA);
      entryB = store.save(fileB);
    } finally {
      Date.now = realNow;
    }

    // The regression: with only Date.now() in the name these are the same path,
    // and saving B clobbers A's snapshot, so restoring A yields B's content.
    expect(entryA?.copy).not.toBe(entryB?.copy);

    await writeFile(fileA, "A-CHANGED\n", "utf8");
    await writeFile(fileB, "B-CHANGED\n", "utf8");
    expect(store.restore(entryA!)).toContain("restored");
    expect(await readFile(fileA, "utf8")).toBe("CONTENT-A\n");
  });

  it("marks a restore as FAILED when the stored copy is gone", async () => {
    const plain = await makePlain();
    const file = join(plain, "gone.ts");
    await writeFile(file, "original\n", "utf8");
    const store = new BackupStore("missing", join(plain, ".backups"));
    const entry = store.save(file)!;
    await rm(entry.copy, { force: true });

    expect(store.restore(entry)).toContain("FAILED");
  });

  it("reports rolledBack false when a snapshot file cannot be restored", async () => {
    const plain = await makePlain();
    const file = join(plain, "gone.ts");
    await writeFile(file, "original\n", "utf8");
    const store = new BackupStore("missing-tx", join(plain, ".backups"));
    const entry = store.save(file)!;
    await rm(entry.copy, { force: true });

    const tx = new TransactionManager({
      shadowGit: new ShadowGit(plain),
      backups: store,
      lsp: new LspSessionPool({ servers: undefined, cwd: plain }),
      defaultTimeoutMs: 5000,
      runCommand: async (command) => ({ command, ok: false, output: "failed" }),
    });

    // Roll back the snapshot the store handed out, so the missing copy is the
    // one under test rather than a fresh save.
    const rolled = tx.rollback({ snapshot: "backups", entries: [entry] });
    expect(rolled.rolledBack).toBe(false);
    expect(rolled.detail).toContain("could not be restored");
  });

  it("undo then redo round-trips a file", async () => {
    const plain = await makePlain();
    const file = join(plain, "round.txt");
    await writeFile(file, "first\n", "utf8");
    const store = new BackupStore("roundtrip", join(plain, ".backups"));
    store.save(file);
    await writeFile(file, "second\n", "utf8");

    store.undo(1);
    expect(await readFile(file, "utf8")).toBe("first\n");
    expect(store.redoDepth()).toBe(1);
    store.redo(1);
    expect(await readFile(file, "utf8")).toBe("second\n");
  });
});

describe("retry policy (maxAttempts)", () => {
  it("calls work once by default and rolls back on the first failure", async () => {
    let calls = 0;
    const tx = manager(root, { "verify fail": false });
    const outcome = await tx.run(
      { label: "single attempt", files: [join(root, "a.ts")], commands: [{ command: "verify fail" }] },
      async () => {
        calls++;
        await writeFile(join(root, "a.ts"), `ATTEMPT-${calls}\n`, "utf8");
      },
    );
    expect(calls).toBe(1);
    expect(outcome.committed).toBe(false);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("retries up to maxAttempts, restoring the baseline before each retry", async () => {
    const seen: (string | number)[] = [];
    // The command passes only once the file holds the good value, so attempt 1
    // fails and attempt 2 succeeds.
    const tx = manager(root, {}, {
      run: (command) => {
        if (command !== "check") return false;
        return seen.length > 1;
      },
    });

    const outcome = await tx.run(
      {
        label: "two attempts",
        files: [join(root, "a.ts")],
        commands: [{ command: "check" }],
        maxAttempts: 2,
      },
      async (attempt) => {
        seen.push(attempt);
        if (attempt === 1) {
          await writeFile(join(root, "a.ts"), "BAD\n", "utf8");
        } else {
          // The baseline must have been restored before this attempt started.
          seen.push(await readFile(join(root, "a.ts"), "utf8"));
          await writeFile(join(root, "a.ts"), "export const a = 99;\n", "utf8");
        }
      },
    );

    expect(outcome.committed).toBe(true);
    expect(seen[0]).toBe(1);
    expect(seen[1]).toBe(2);
    expect(seen[2]).toBe("export const a = 1;\n");
  });

  it("gives up after maxAttempts and rolls back", async () => {
    let calls = 0;
    const tx = manager(root, { "verify fail": false });
    const outcome = await tx.run(
      {
        label: "always fails",
        files: [join(root, "a.ts")],
        commands: [{ command: "verify fail" }],
        maxAttempts: 3,
      },
      async () => {
        calls++;
        await writeFile(join(root, "a.ts"), `TRY-${calls}\n`, "utf8");
      },
    );

    expect(calls).toBe(3);
    expect(outcome.committed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });
});

describe("shadow git checkpoints", () => {
  it("gives two instances created in the same millisecond separate index files", async () => {
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    let first: ShadowGit;
    let second: ShadowGit;
    try {
      first = new ShadowGit(root);
      second = new ShadowGit(root);
    } finally {
      Date.now = realNow;
    }
    // Reaching into the private field is the point of the test: two live
    // checkpoints sharing one index file interleave their git calls.
    const firstIndex = (first as unknown as { indexPath: string }).indexPath;
    const secondIndex = (second as unknown as { indexPath: string }).indexPath;
    expect(firstIndex).not.toBe(secondIndex);
    first.dispose();
    second.dispose();
  });

  it("preserves CRLF line endings through a rewind", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "crlf.txt"), "line1\r\nline2\r\n", "utf8");
    const shadow = new ShadowGit(dir);
    const checkpoint = shadow.create("with crlf")!;

    await writeFile(join(dir, "crlf.txt"), "line1\nline2\n", "utf8");
    shadow.rewind(checkpoint);

    expect(await readFile(join(dir, "crlf.txt"), "utf8")).toBe("line1\r\nline2\r\n");
    shadow.dispose();
  });

  it("restores the executable bit through a rewind", async () => {
    const dir = await makeRepo();
    const script = join(dir, "run.sh");
    await writeFile(script, "#!/bin/sh\necho hi\n", "utf8");
    await chmodSync(script, 0o755);
    const shadow = new ShadowGit(dir);
    const checkpoint = shadow.create("with exec")!;

    if (process.platform === "win32") {
      // Windows has no POSIX mode bits and Git does not track them. Assert the
      // invariant that actually matters there: the rewind restores the content.
      await writeFile(script, "#!/bin/sh\necho changed\n", "utf8");
      shadow.rewind(checkpoint);
      expect(await readFile(script, "utf8")).toContain("echo hi");
      shadow.dispose();
      return;
    }

    await chmodSync(script, 0o600);
    expect((await statSync(script)).mode & 0o111).toBe(0);

    shadow.rewind(checkpoint);
    expect((await statSync(script)).mode & 0o111).not.toBe(0);
    shadow.dispose();
  });

  it("is inert outside a repository", async () => {
    const plain = await makePlain();
    const shadow = new ShadowGit(plain);
    expect(shadow.enabled).toBe(false);
    expect(shadow.create("nothing")).toBeUndefined();
    shadow.dispose();
  });
});
