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

export type AgentPermissionAction = "allow" | "ask" | "deny";

/** The `permission:` block, shaped like the one the terminal world expects. */
export interface AgentPermission {
  edit?: AgentPermissionAction;
  webfetch?: AgentPermissionAction;
  bash?: { pattern: string; action: AgentPermissionAction }[];
}

/** Tools a preset means by `permission.edit`. */
export const EDIT_TOOLS = [
  "edit_file",
  "write_file",
  "write_many",
  "apply_patch",
  "file_append",
  "file_delete",
  "file_move",
  "file_copy",
  "make_dir",
];

/** Tools a preset means by `permission.webfetch`. */
export const WEB_TOOLS = ["web_fetch", "web_search", "network_request", "http_download"];

export interface AgentPreset {
  name: string;
  description: string;
  /** Body of the file: instructions appended to the system prompt. */
  prompt: string;
  mode?: PermissionMode;
  tools?: string[];
  model?: string;
  effort?: Effort;
  /** Tool and command rules; a `deny` always wins over an `allow`. */
  permission?: AgentPermission;
  source: "project" | "user";
  path: string;
}

const FRONTMATTER_KEYS = new Set(["description", "mode", "tools", "model", "effort"]);

/**
 * Splits a preset file into frontmatter and body. A file without a leading
 * `---` is all body, which keeps a plain markdown note usable as a preset.
 */
export function splitFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
  /** Raw indented lines of the `permission:` block, parsed separately. */
  permissionLines: string[];
} {
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { meta: {}, body: text.trim(), permissionLines: [] };
  const meta: Record<string, string> = {};
  const permissionLines: string[] = [];
  let collectingPermission = false;
  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") {
      end = index;
      break;
    }
    // Indented lines belong to the block above them, which can only be
    // `permission:`; nothing else in the frontmatter nests.
    if (/^\s+\S/.test(line)) {
      if (collectingPermission) permissionLines.push(line);
      continue;
    }
    collectingPermission = false;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "permission" && value.length === 0) {
      collectingPermission = true;
      continue;
    }
    if (FRONTMATTER_KEYS.has(key) && value.length > 0) {
      meta[key] = value.replace(/^["'](.*)["']$/, "$1");
    }
  }
  if (end === -1) return { meta: {}, body: text.trim(), permissionLines: [] };
  return { meta, body: lines.slice(end + 1).join("\n").trim(), permissionLines };
}

function actionOf(value: string): AgentPermissionAction | undefined {
  const normalized = value.trim().toLowerCase().replace(/^["']|["']$/g, "");
  return normalized === "allow" || normalized === "ask" || normalized === "deny" ? normalized : undefined;
}

/**
 * Parses the `permission:` block. Two levels only: `edit`/`webfetch` are an
 * action, `bash` is a map from command pattern to action.
 */
export function parsePermission(lines: string[]): AgentPermission | undefined {
  const result: AgentPermission = {};
  let inBash = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    const separator = body.indexOf(":");
    if (separator === -1) continue;
    const key = body.slice(0, separator).trim();
    const value = body.slice(separator + 1).trim();

    if (indent <= 2) {
      const lower = key.toLowerCase();
      inBash = false;
      if (lower === "bash" && value.length === 0) {
        inBash = true;
        result.bash ??= [];
        continue;
      }
      const action = actionOf(value);
      if (action === undefined) continue;
      if (lower === "edit") result.edit = action;
      else if (lower === "webfetch") result.webfetch = action;
      continue;
    }

    if (!inBash) continue;
    const pattern = key.replace(/^["']|["']$/g, "");
    const action = actionOf(value);
    if (pattern.length === 0 || action === undefined) continue;
    result.bash ??= [];
    result.bash.push({ pattern, action });
  }
  return Object.keys(result).length === 0 ? undefined : result;
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
  const { meta, body, permissionLines } = splitFrontmatter(raw);
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
  const permission = parsePermission(permissionLines);
  if (permission !== undefined) preset.permission = permission;
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
  if (preset.permission !== undefined) next.permissions = foldPermission(config.permissions, preset.permission);
  return next;
}

function pushUnique(list: string[], items: readonly string[]): void {
  for (const item of items) if (!list.includes(item)) list.push(item);
}

/**
 * Turns the preset's `permission:` block into the two lists the gate already
 * understands: tool names, and bash command patterns. `ask` is the default, so
 * it only removes the pattern from the allow list.
 */
export function foldPermission(
  base: ResolvedConfig["permissions"],
  permission: AgentPermission,
): ResolvedConfig["permissions"] {
  const next: ResolvedConfig["permissions"] = {
    allow: [...base.allow],
    deny: [...base.deny],
    toolAllow: [...(base.toolAllow ?? [])],
    toolDeny: [...(base.toolDeny ?? [])],
  };
  const toolAllow = next.toolAllow ?? [];
  const toolDeny = next.toolDeny ?? [];

  if (permission.edit === "deny") pushUnique(toolDeny, EDIT_TOOLS);
  if (permission.edit === "allow") pushUnique(toolAllow, EDIT_TOOLS);
  if (permission.webfetch === "deny") pushUnique(toolDeny, WEB_TOOLS);
  if (permission.webfetch === "allow") pushUnique(toolAllow, WEB_TOOLS);

  for (const rule of permission.bash ?? []) {
    if (rule.action === "allow") pushUnique(next.allow, [rule.pattern]);
    if (rule.action === "deny") pushUnique(next.deny, [rule.pattern]);
    if (rule.action === "ask") {
      next.allow = next.allow.filter((pattern) => pattern !== rule.pattern);
    }
  }
  return next;
}
