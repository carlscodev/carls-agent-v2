import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillCurator } from "../src/skills/SkillCurator.js";
import { SkillEvolutionEngine } from "../src/skills/SkillEvolutionEngine.js";
import { SkillGraph, SkillHistory } from "../src/skills/SkillEvolution.js";
import { SkillLoader, parseFrontmatter } from "../src/skills/SkillLoader.js";
import { SkillRegistry } from "../src/skills/SkillRegistry.js";
import { SaveSkill } from "../src/tools/SaveSkill.js";
import { EvolveSkill, RevertSkill, SkillGraphTool, SkillHistoryTool } from "../src/tools/SkillEvolutionTools.js";
import { Logger } from "../src/utils/Logger.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { loadConfig } from "../src/config/Config.js";
import type { ToolContext } from "../src/types/tools.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "carls-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const BODY = [
  "1. Read the target file first.",
  "2. Apply the change.",
  "3. Verify the result with the test command.",
  "",
].join("\n");

/** Writes a skill straight to disk, bypassing validation, to build graph shapes. */
async function seedSkill(name: string, frontmatter: string, body = BODY): Promise<void> {
  const dir = join(root, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\n${body}`, "utf8");
}

function makeContext(): ToolContext {
  const config = loadConfig({}, root);
  const session = new SessionStore(root, config.model, undefined, join(root, "sessions"));
  return {
    cwd: root,
    config,
    session,
    logger: new Logger("error"),
    signal: new AbortController().signal,
    skills: new SkillRegistry(root, join(root, ".carls")),
  };
}

describe("evolve_skill curation gate", () => {
  it("creates a skill, writes it to .agents/skills and records a revision", async () => {
    const engine = new SkillEvolutionEngine(root);
    const outcome = engine.evolve(
      { name: "demo", description: "A demo skill.", body: BODY, note: "first" },
      undefined,
      false,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.version).toBe(1);
    expect(existsSync(join(root, ".agents", "skills", "demo", "SKILL.md"))).toBe(true);
    expect(engine.historyFor("demo")).toHaveLength(1);
  });

  it("rejects a bad name, an empty body and a missing description", () => {
    const engine = new SkillEvolutionEngine(root);
    const bad = engine.evolve({ name: "Bad Name", description: "", body: "", note: "x" }, undefined, false);
    expect(bad.ok).toBe(false);
    const fields = bad.validation.issues.map((issue) => issue.field);
    expect(fields).toContain("name");
    expect(fields).toContain("body");
    expect(fields).toContain("description");
  });

  it("rejects a requires on an unknown skill and a self-require", () => {
    const engine = new SkillEvolutionEngine(root);
    const missing = engine.evolve(
      { name: "demo", description: "A demo skill.", body: BODY, requires: ["ghost"], note: "x" },
      undefined,
      false,
    );
    expect(missing.ok).toBe(false);
    expect(missing.validation.issues.some((issue) => issue.field === "requires")).toBe(true);

    const self = engine.evolve(
      { name: "demo", description: "A demo skill.", body: BODY, requires: ["demo"], note: "x" },
      undefined,
      false,
    );
    expect(self.ok).toBe(false);
    expect(self.validation.issues.some((issue) => issue.message.includes("cannot require itself"))).toBe(true);
  });

  it("refuses to shadow an existing skill without replace: true", async () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);
    const again = engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "second" }, undefined, false);
    expect(again.ok).toBe(false);
    expect(again.validation.issues.some((issue) => issue.message.includes("already exists"))).toBe(true);
  });

  it("refuses a rewrite that grew without adding a step, command or check", async () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);

    // The regression: growth smaller than the frontmatter's own length used to
    // look like a shrink because the comparison mixed file length with body length.
    const padded = `${BODY}Extra padding words here, no steps.`;
    const outcome = engine.evolve(
      { name: "demo", description: "A demo skill.", body: padded, note: "pad it" },
      undefined,
      true,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.rejected).toContain("without adding a step");
  });

  it("accepts a rewrite that grows but adds a new step", async () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);

    const withStep = `${BODY}4. Then confirm the build artifact exists.\n`;
    const outcome = engine.evolve(
      { name: "demo", description: "A demo skill.", body: withStep, note: "adds a step" },
      undefined,
      true,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.version).toBe(2);
  });

  it("accepts a rewrite that shortens the body", async () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);
    const shorter = "1. Do the one thing that matters.\n";
    const outcome = engine.evolve(
      { name: "demo", description: "A demo skill.", body: shorter, note: "tighter" },
      undefined,
      true,
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("skill history and revert", () => {
  it("records monotonic versions and keeps the full file per revision", () => {
    const history = new SkillHistory(join(root, ".carls"));
    expect(history.record("demo", "v1 contents", "first").version).toBe(1);
    expect(history.record("demo", "v2 contents", "second").version).toBe(2);
    expect(history.revisions("demo").map((r) => r.version)).toEqual([1, 2]);
    expect(history.latest("demo")?.contents).toBe("v2 contents");
    expect(history.previous("demo")?.contents).toBe("v1 contents");
  });

  it("persists history across instances", () => {
    new SkillHistory(join(root, ".carls")).record("demo", "v1", "first");
    const reopened = new SkillHistory(join(root, ".carls"));
    expect(reopened.revisions("demo")).toHaveLength(1);
    expect(reopened.tracked()).toContain("demo");
  });

  it("reverts to the exact previous file contents", async () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);
    const file = join(root, ".agents", "skills", "demo", "SKILL.md");
    const v1 = await readFile(file, "utf8");

    engine.evolve(
      { name: "demo", description: "A demo skill.", body: `${BODY}4. One more step for the rewrite.\n`, note: "second" },
      undefined,
      true,
    );
    expect(await readFile(file, "utf8")).not.toBe(v1);

    const reverted = engine.revert("demo", undefined);
    expect(reverted.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(v1);
    // The revert is itself recorded, so it can be undone.
    expect(engine.historyFor("demo")).toHaveLength(3);
  });

  it("refuses to revert when there is no earlier revision", () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);
    const result = engine.revert("demo", undefined);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no earlier revision");
  });

  it("does not blank a skill on a failed revert", async () => {
    const engine = new SkillEvolutionEngine(root);
    engine.evolve({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }, undefined, false);
    const file = join(root, ".agents", "skills", "demo", "SKILL.md");
    const before = await readFile(file, "utf8");
    engine.revert("demo", undefined);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("skill graph", () => {
  it("derives requires, extends and related edges from frontmatter", async () => {
    await seedSkill("base", "description: base\n");
    await seedSkill("child", "description: child\nrequires: [base]\nextends: [base]\nrelated: [base]\n");
    const graph = new SkillGraph(SkillLoader.discover(root));

    expect(graph.dependencies("child").map((edge) => edge.kind).sort()).toEqual(["extends", "related", "requires"]);
    expect(graph.dependents("base")).toHaveLength(3);
  });

  it("ignores a relationship pointing at an unknown skill", async () => {
    await seedSkill("child", "description: child\nrequires: [ghost]\n");
    const graph = new SkillGraph(SkillLoader.discover(root));
    expect(graph.all()).toEqual([]);
  });

  it("computes a transitive requires-closure", async () => {
    await seedSkill("a", "description: a\n");
    await seedSkill("b", "description: b\nrequires: [a]\n");
    await seedSkill("c", "description: c\nrequires: [b]\n");
    const graph = new SkillGraph(SkillLoader.discover(root));
    expect(graph.closure("c").sort()).toEqual(["a", "b"]);
  });

  it("detects a cycle and terminates instead of recursing forever", async () => {
    await seedSkill("a", "description: a\nrequires: [b]\n");
    await seedSkill("b", "description: b\nrequires: [a]\n");
    const graph = new SkillGraph(SkillLoader.discover(root));

    const cycles = graph.cycles();
    expect(cycles.length).toBeGreaterThan(0);
    const flat = cycles.flat();
    expect(flat).toContain("a");
    expect(flat).toContain("b");
    // The closure must return too, not spin on the cycle.
    expect(graph.closure("a")).toContain("b");
  });

  it("finds no cycle in a diamond", async () => {
    await seedSkill("top", "description: top\nrequires: [left, right]\n");
    await seedSkill("left", "description: left\nrequires: [bottom]\n");
    await seedSkill("right", "description: right\nrequires: [bottom]\n");
    await seedSkill("bottom", "description: bottom\n");
    const graph = new SkillGraph(SkillLoader.discover(root));
    expect(graph.cycles()).toEqual([]);
    expect(graph.closure("top").sort()).toEqual(["bottom", "left", "right"]);
  });
});

describe("curation review queue", () => {
  it("prioritises a flagged skill over a stale one over an unused one", async () => {
    await seedSkill("flagged", "description: flagged\n");
    await seedSkill("stale", "description: stale\nrequires: [dependency]\n");
    await seedSkill("dependency", "description: dependency\n");
    await seedSkill("unused", "description: unused\n");

    const history = new SkillHistory(join(root, ".carls"));
    // The dependency was revised after `stale` was written, which makes `stale`
    // suspect; the others have no history, so they read as never-used. The clock
    // is advanced between records because two writes in the same millisecond
    // produce identical ISO timestamps and the staleness check compares them.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      history.record("stale", "stale contents", "written first");
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      history.record("dependency", "dependency contents", "revised later");
    } finally {
      vi.useRealTimers();
    }

    const curator = new SkillCurator(new SkillGraph(SkillLoader.discover(root)), history);
    const queue = curator.candidates(SkillLoader.discover(root), (name) =>
      name === "flagged" ? { uses: 1, needsWork: true } : undefined,
    );

    const byName = new Map(queue.map((candidate) => [candidate.name, candidate.priority]));
    expect(byName.get("flagged")).toBe(100);
    expect(byName.get("stale")).toBe(60);
    expect(byName.get("unused")).toBe(20);
    // Sorted by priority descending.
    expect(queue[0]?.name).toBe("flagged");
  });

  it("does not flag a skill that was revised after its dependency", async () => {
    await seedSkill("stale", "description: stale\nrequires: [dependency]\n");
    await seedSkill("dependency", "description: dependency\n");
    const history = new SkillHistory(join(root, ".carls"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      history.record("dependency", "dependency contents", "first");
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      history.record("stale", "stale contents", "later");
    } finally {
      vi.useRealTimers();
    }

    const curator = new SkillCurator(new SkillGraph(SkillLoader.discover(root)), history);
    const queue = curator.candidates(SkillLoader.discover(root), () => ({ uses: 3 }));
    expect(queue.map((candidate) => candidate.name)).not.toContain("stale");
  });
});

describe("skill evolution tools", () => {
  it("evolve_skill reports the saved version and surfaces warnings", async () => {
    const tool = new EvolveSkill();
    const ctx = makeContext();
    const result = await tool.run(tool.parse({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }), ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("v1");
  });

  it("evolve_skill returns the rejection reason when the growth rule blocks a rewrite", async () => {
    const tool = new EvolveSkill();
    const ctx = makeContext();
    await tool.run(tool.parse({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }), ctx);
    const padded = `${BODY}Extra padding words here, no steps.`;
    const result = await tool.run(
      tool.parse({ name: "demo", description: "A demo skill.", body: padded, note: "pad", replace: true }),
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("without adding a step");
  });

  it("skill_history lists the revisions and revert_skill restores the previous one", async () => {
    const ctx = makeContext();
    const evolve = new EvolveSkill();
    await evolve.run(evolve.parse({ name: "demo", description: "A demo skill.", body: BODY, note: "first" }), ctx);
    await evolve.run(
      evolve.parse({ name: "demo", description: "A demo skill.", body: `${BODY}4. One more step for the rewrite.\n`, note: "second", replace: true }),
      ctx,
    );

    const historyTool = new SkillHistoryTool();
    const history = await historyTool.run(historyTool.parse({ name: "demo" }), ctx);
    expect(history.ok).toBe(true);
    expect(history.output).toContain("v1");
    expect(history.output).toContain("v2");

    const revertTool = new RevertSkill();
    const reverted = await revertTool.run(revertTool.parse({ name: "demo" }), ctx);
    expect(reverted.ok).toBe(true);
    expect(reverted.output).toContain("v1");
  });

  it("skill_graph warns about a cycle", async () => {
    await seedSkill("a", "description: a\nrequires: [b]\n");
    await seedSkill("b", "description: b\nrequires: [a]\n");
    const tool = new SkillGraphTool();
    const result = await tool.run(tool.parse({}), makeContext());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("cycle");
    expect(result.metadata?.cycles).toBeGreaterThan(0);
  });

  it("save_skill protects a non-project skill behind overwrite: true", async () => {
    // A user-level skill with the same name shadows the project lookup.
    const userDir = join(root, "home", ".carls", "skills", "shared");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "SKILL.md"), "---\nname: shared\ndescription: user skill\n---\n\nBody.\n", "utf8");
    const savedHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      const ctx = makeContext();
      ctx.skills?.refresh();
      const tool = new SaveSkill();
      const blocked = await tool.run(
        tool.parse({ name: "shared", description: "project skill", body: BODY }),
        ctx,
      );
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toContain("already exists");

      const allowed = await tool.run(
        tool.parse({ name: "shared", description: "project skill", body: BODY, overwrite: true }),
        ctx,
      );
      expect(allowed.ok).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

describe("frontmatter parsing", () => {
  it("reads scalars, inline lists and block lists", () => {
    const raw = [
      "---",
      "name: demo",
      "description: a demo",
      "tags: [one, two]",
      "requires:",
      "  - alpha",
      "  - beta",
      "---",
      "",
      "body line",
    ].join("\n");
    const { data, body } = parseFrontmatter(raw);
    expect(data.name).toBe("demo");
    expect(data.tags).toEqual(["one", "two"]);
    expect(data.requires).toEqual(["alpha", "beta"]);
    expect(body.trim()).toBe("body line");
  });

  it("treats a file with no frontmatter as all body", () => {
    const { data, body } = parseFrontmatter("just text");
    expect(data).toEqual({});
    expect(body).toBe("just text");
  });
});
