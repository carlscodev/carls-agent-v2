import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode, type ResolvedConfig } from "../config/Config.js";
import { userDataDir } from "../utils/platform.js";

/**
 * Agent presets.
 *
 * A preset is a markdown file with frontmatter: the body is appended to the
 * system prompt, the frontmatter narrows the permission mode, the tool set, the
 * model and the effort. The point is that a project can define `reviewer`,
 * `migrator` or `docs` once and switch between them, instead of retyping the
 * same instructions and mode changes every session.
 *
 *   ---
 *   description: Reviews a diff for correctness, never edits
 *   mode: plan
 *   tools: read_file, grep_search, glob_files, bash
 *   effort: high
 *   ---
 *   You are a reviewer. Read the diff, ...
 *
 * Two layers, project first: `<cwd>/.agents/agents/*.md` then
 * `~/.carls/agents/*.md`. A project file with the same name wins.
 */

export interface AgentPreset {
  name: string;
  description: string;
  /** Body of the file: instructions appended to the system prompt. */
  prompt: string;
  mode?: PermissionMode;
  tools?: string[];
  model?: string;
  effort?: Effort;
  source: "project" | "user";
  path: string;
}

const FRONTMATTER_KEYS = new Set(["description", "mode", "tools", "model", "effort"]);

/**
 * Splits a preset file into frontmatter and body. A file without a leading
 * `---` is all body, which keeps a plain markdown note usable as a preset.
 */
export function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") {
      end = index;
      break;
    }
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (FRONTMATTER_KEYS.has(key) && value.length > 0) {
      meta[key] = value.replace(/^["'](.*)["']$/, "$1");
    }
  }
  if (end === -1) return { meta: {}, body: text.trim() };
  return { meta, body: lines.slice(end + 1).join("\n").trim() };
}

function parseMode(value: string | undefined): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode === value);
}

function parseEffort(value: string | undefined): Effort | undefined {
  return EFFORTS.find((effort) => effort === value);
}

/** Builds one preset from a file. Invalid frontmatter values are dropped. */
export function parsePreset(
  name: string,
  raw: string,
  source: "project" | "user",
  path: string,
): AgentPreset {
  const { meta, body } = splitFrontmatter(raw);
  const preset: AgentPreset = {
    name,
    description: meta.description ?? `agent from ${path}`,
    prompt: body,
    source,
    path,
  };
  const mode = parseMode(meta.mode);
  if (mode !== undefined) preset.mode = mode;
  const effort = parseEffort(meta.effort);
  if (effort !== undefined) preset.effort = effort;
  if (meta.model !== undefined && meta.model.length > 0) preset.model = meta.model;
  if (meta.tools !== undefined) {
    const tools = meta.tools
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);
    if (tools.length > 0) preset.tools = tools;
  }
  return preset;
}

function readPresetDir(dir: string, source: "project" | "user"): AgentPreset[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const presets: AgentPreset[] = [];
  for (const file of names) {
    const path = join(dir, file);
    try {
      presets.push(parsePreset(file.replace(/\.md$/, ""), readFileSync(path, "utf8"), source, path));
    } catch {
      // An unreadable preset is not worth failing a session over.
    }
  }
  return presets;
}

/** Every available preset, project layer shadowing the user layer by name. */
export function discoverAgents(cwd: string): AgentPreset[] {
  const project = readPresetDir(join(cwd, ".agents", "agents"), "project");
  const taken = new Set(project.map((preset) => preset.name));
  const user = readPresetDir(join(userDataDir(), "agents"), "user").filter(
    (preset) => !taken.has(preset.name),
  );
  return [...project, ...user].sort((a, b) => a.name.localeCompare(b.name));
}

/** Looks a preset up by name, case-insensitively. */
export function findAgent(presets: AgentPreset[], name: string): AgentPreset | undefined {
  const wanted = name.trim().toLowerCase();
  return presets.find((preset) => preset.name.toLowerCase() === wanted);
}

/**
 * Folds a preset into a resolved config. Only fields the preset actually sets
 * are touched, so an agent without `model` keeps the user's model.
 */
export function applyPreset(config: ResolvedConfig, preset: AgentPreset): ResolvedConfig {
  const next: ResolvedConfig = { ...config, agentName: preset.name, agentPrompt: preset.prompt };
  if (preset.mode !== undefined) next.mode = preset.mode;
  if (preset.effort !== undefined) next.effort = preset.effort;
  if (preset.model !== undefined) next.model = preset.model;
  if (preset.tools !== undefined) next.tools = preset.tools;
  return next;
}
