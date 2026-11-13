import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findRuntimeDirectory, runtimeRoots } from "../os/RuntimePaths.js";

/**
 * Build-time snapshot of `skills/`. The bundle defines this identifier with an
 * object of `relative/path.md -> contents`, which is what makes `carls.exe`
 * self-contained: no skills directory has to travel with the executable. In a
 * checkout the identifier is absent and the loader reads the directory.
 */
declare const __CARLS_EMBEDDED_SKILLS__: Record<string, string> | undefined;

function embeddedSkillSources(): Record<string, string> | undefined {
  return typeof __CARLS_EMBEDDED_SKILLS__ !== "undefined" ? __CARLS_EMBEDDED_SKILLS__ : undefined;
}

export interface Skill {
  name: string;
  description: string;
  /** Optional hint the model reads to decide whether to load the body. */
  whenToUse?: string;
  tags: string[];
  version?: number;
  /** Absolute path of the file the skill was loaded from. */
  path: string;
  /** Where it came from, shown in listings. */
  source: "builtin" | "project" | "user";
  /** Body without the frontmatter. */
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal YAML frontmatter reader: scalars, inline lists and block lists. */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, unknown> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  let listKey: string | undefined;

  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey !== undefined) {
      const current = (data[listKey] as string[] | undefined) ?? [];
      current.push(unquote(item[1] ?? ""));
      data[listKey] = current;
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1] ?? "";
    const value = (pair[2] ?? "").trim();
    if (value.length === 0) {
      listKey = key;
      data[key] = [];
      continue;
    }
    listKey = undefined;
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((entry) => unquote(entry.trim()))
        .filter((entry) => entry.length > 0);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: raw.slice(match[0].length) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Root directory holding the bundled skills that ship with the package. */
export function builtinSkillsDir(): string {
  // `runtimeRoots()` also contains compiled module folders; `dist/src/skills`
  // exists but holds only `.js`. A candidate is the catalog only when it has a
  // real skill file, otherwise the loader would silently discover zero builtins.
  for (const root of runtimeRoots()) {
    const candidate = join(root, "skills");
    if (!existsSync(candidate)) continue;
    try {
      const entries = readdirSync(candidate);
      const hasSkill = entries.some(
        (entry) => entry.endsWith(".md") || existsSync(join(candidate, entry, "SKILL.md")),
      );
      if (hasSkill) return candidate;
    } catch {
      // An unreadable candidate is not the catalog; try the next root.
    }
  }
  return findRuntimeDirectory("skills") ?? join(runtimeRoots()[0] ?? process.cwd(), "skills");
}

function readSkillContent(
  raw: string,
  path: string,
  source: Skill["source"],
  fallbackName: string,
): Skill | undefined {
  try {
    const { data, body } = parseFrontmatter(raw);
    const name = asString(data.name) ?? fallbackName;
    const description =
      asString(data.description) ??
      body.split("\n").find((line) => line.trim().length > 0)?.trim() ??
      name;
    const tags = Array.isArray(data.tags)
      ? (data.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
      : [];
    const version = Number.parseInt(String(data.version ?? ""), 10);
    const skill: Skill = { name, description, tags, path, source, body: body.trim() };
    const whenToUse = asString(data.when_to_use) ?? asString(data.whenToUse);
    if (whenToUse !== undefined) skill.whenToUse = whenToUse;
    if (Number.isFinite(version)) skill.version = version;
    return skill;
  } catch {
    return undefined;
  }
}

function readSkillFile(path: string, source: Skill["source"], fallbackName: string): Skill | undefined {
  try {
    return readSkillContent(readFileSync(path, "utf8"), path, source, fallbackName);
  } catch {
    return undefined;
  }
}

/**
 * Discovers skills from the bundled catalog, the user's home directory and the
 * current project. Later sources win, so a project can override a builtin.
 */
export class SkillLoader {
  static discover(cwd: string): Skill[] {
    const byName = new Map<string, Skill>();

    const embedded = embeddedSkillSources();
    const builtins =
      embedded !== undefined
        ? SkillLoader.loadEmbedded(embedded)
        : SkillLoader.loadDir(builtinSkillsDir(), "builtin");
    for (const skill of builtins) byName.set(skill.name, skill);
    for (const skill of SkillLoader.loadDir(join(homedir(), ".carls", "skills"), "user")) {
      byName.set(skill.name, skill);
    }
    for (const dir of [join(cwd, ".agents", "skills"), join(cwd, ".carls", "skills")]) {
      for (const skill of SkillLoader.loadDir(dir, "project")) byName.set(skill.name, skill);
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Parses the build-time snapshot; keys are sorted for a stable listing. */
  private static loadEmbedded(sources: Record<string, string>): Skill[] {
    const skills: Skill[] = [];
    for (const key of Object.keys(sources).sort()) {
      const raw = sources[key];
      if (raw === undefined) continue;
      const normalized = key.replace(/\\/g, "/");
      const stem = normalized.endsWith("/SKILL.md")
        ? (normalized.slice(0, -"/SKILL.md".length).split("/").pop() ?? normalized)
        : (normalized.replace(/\.md$/i, "").split("/").pop() ?? normalized);
      const skill = readSkillContent(raw, `builtin:${normalized}`, "builtin", stem);
      if (skill !== undefined) skills.push(skill);
    }
    return skills;
  }

  /** Reads either `<dir>/<name>/SKILL.md` or `<dir>/<name>.md`. */
  private static loadDir(dir: string, source: Skill["source"]): Skill[] {
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const skills: Skill[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          const file = join(full, "SKILL.md");
          if (!existsSync(file)) continue;
          const skill = readSkillFile(file, source, entry);
          if (skill) skills.push(skill);
        } else if (entry.endsWith(".md")) {
          const skill = readSkillFile(full, source, entry.replace(/\.md$/, ""));
          if (skill) skills.push(skill);
        }
      } catch {
        continue;
      }
    }
    return skills;
  }

  /** Writes a skill into the project, returning the file path. */
  static write(cwd: string, name: string, content: string): string {
    const dir = join(cwd, ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    return file;
  }
}
