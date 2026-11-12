import { COMMANDS } from "./Commands.js";
import { EFFORTS, PERMISSION_MODES } from "../config/Config.js";
import type { Runtime } from "../core/Runtime.js";
import { listWorkspaceFiles } from "./Mentions.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { knownModelsFor } from "../models/Catalog.js";
import { discoverAgents } from "../agents/Presets.js";

/** One row of the completion menu. */
export interface Completion {
  /** Text that replaces the token under the cursor when accepted. */
  value: string;
  /** What the user sees on the left. */
  label: string;
  /** Short explanation on the right. */
  detail?: string;
  /** Coarse bucket, used to colour the row. */
  kind: "command" | "arg" | "skill" | "model" | "file" | "flag";
}

export interface CompletionRequest {
  /** The whole line as typed. */
  line: string;
  /** Cursor offset into `line`. */
  cursor: number;
  runtime: Runtime;
}

export interface CompletionResult {
  /** Rows to show, best match first. */
  items: Completion[];
  /** Offset in `line` where the replaced token begins. */
  start: number;
  /** Offset in `line` where the replaced token ends. */
  end: number;
}

/**
 * Context-aware completion for the prompt line.
 *
 * The menu is built from what the line can actually accept at the cursor: a
 * slash command name in the first token, then the command's own argument set —
 * permission modes for `/mode`, efforts for `/effort`, skill names for
 * `/skills show`, model ids for `/model`, and so on. Anything after a bare
 * argument falls back to workspace paths, which is what the user usually wants.
 *
 * Returning `undefined` means "nothing to offer", and the caller hides the menu
 * rather than showing an empty box.
 */
export function complete(request: CompletionRequest): CompletionResult | undefined {
  const { line, cursor, runtime } = request;
  // Only the text before the cursor can constrain what may come next.
  const head = line.slice(0, cursor);
  // The token being typed is the last run of non-space characters.
  const tokenMatch = /(\S*)$/.exec(head);
  const token = tokenMatch?.[1] ?? "";
  const start = head.length - token.length;
  const before = head.slice(0, start);

  const isFirstToken = before.trim().length === 0;
  if (isFirstToken) {
    // A bare `@` is the file picker's job, handled by the REPL itself.
    if (token.startsWith("@")) return undefined;
    if (!token.startsWith("/")) return undefined;
    return { items: rank(commands(), token), start, end: cursor };
  }

  if (!before.trimStart().startsWith("/")) return undefined;
  const words = before.trim().split(/\s+/);
  const command = words[0] ?? "";
  // `before` always ends with the space the user just typed, so its word count
  // minus one is the index of the argument under the cursor: `/mode ` is
  // argument 0, `/mode yolo ` is argument 1.
  const argIndex = words.length - 1;
  const end = cursor;

  const args = argumentsFor(command, argIndex, runtime);
  if (args !== undefined) {
    const items = rank(args, token);
    return items.length > 0 ? { items, start, end } : undefined;
  }

  // No curated argument set: offer workspace paths, the same list `@` uses.
  const files = listWorkspaceFiles(runtime.config.cwd).map<Completion>((path) => ({
    value: path,
    label: path,
    kind: "file",
  }));
  const items = rank(files, token);
  return items.length > 0 ? { items, start, end } : undefined;
}

/** Every command as a completion row, aliases included. */
export function commandItems(): Completion[] {
  const items: Completion[] = [];
  for (const command of COMMANDS) {
    items.push({
      value: command.name,
      label: command.usage ?? command.name,
      detail: command.summary,
      kind: "command",
    });
    for (const alias of command.aliases ?? []) {
      items.push({ value: alias, label: alias, detail: `${command.summary} (alias)`, kind: "command" });
    }
  }
  return items;
}

const commands = commandItems;

/** Literal choices as completion rows. */
function literals(values: readonly string[], kind: Completion["kind"]): Completion[] {
  return values.map((value) => ({ value, label: value, kind }));
}

/**
 * Curated arguments per command. `argIndex` is 0 for the first argument, so a
 * command whose second word is free-form (a file path, a message) returns
 * undefined and lets the file fallback run.
 */
function argumentsFor(command: string, argIndex: number, runtime: Runtime): Completion[] | undefined {
  const subcommands = (names: string[]): Completion[] => literals(names, "arg");
  switch (command) {
    case "/mode":
    case "/permissions":
      return literals(PERMISSION_MODES, "arg");
    case "/effort":
      return literals([...EFFORTS, "off"], "arg");
    case "/theme":
      return literals(["dark", "light"], "arg");
    case "/model":
      return argIndex === 0 ? modelItems(runtime) : undefined;
    case "/skills":
      if (argIndex === 0) return subcommands(["list", "search", "show", "review", "new"]);
      // `show`, `new` and `search` all take a skill name or a query.
      return skillItems(runtime.config.cwd);
    case "/agents":
    case "/agent":
      if (argIndex === 0) return subcommands(["list", "use"]);
      return argIndex === 1 ? agentItems(runtime) : undefined;
    case "/tools":
      return argIndex === 0 ? subcommands(["list", "search"]) : undefined;
    case "/tab":
      return subcommands(["list", "new", "close", "next"]);
    case "/export":
      return argIndex === 0 ? subcommands(["markdown", "json"]) : undefined;
    case "/setup":
      return subcommands(["reset"]);
    default:
      return undefined;
  }
}

/** Skill names, used by `/skills show` and `/skills new`. */
export function skillItems(cwd: string): Completion[] {
  return SkillLoader.discover(cwd).map((skill) => ({
    value: skill.name,
    label: skill.name,
    detail: skill.description,
    kind: "skill",
  }));
}

/** Known model ids for the configured provider. */
export function modelItems(runtime: Runtime): Completion[] {
  return knownModelsFor(runtime.config.provider, runtime.config.contextWindow).map((model) => ({
    value: model.id,
    label: model.id,
    kind: "model",
    ...(model.reasoning === true ? { detail: "reasoning" } : {}),
  }));
}

/** Discovered agent presets, by name. */
export function agentItems(runtime: Runtime): Completion[] {
  return discoverAgents(runtime.config.cwd).map((preset) => ({
    value: preset.name,
    label: preset.name,
    kind: "arg",
  }));
}

/**
 * Ranks candidates for a token: exact prefix matches first, then substring
 * matches, then fuzzy subsequence matches. Empty token returns everything in
 * declaration order, which is what makes a bare `/` list the whole catalog.
 */
export function rank(items: Completion[], token: string): Completion[] {
  if (token.length === 0) return items;
  const needle = token.toLowerCase();
  const scored: { item: Completion; score: number }[] = [];
  for (const item of items) {
    const hay = item.value.toLowerCase();
    if (hay === needle) {
      scored.push({ item, score: 0 });
      continue;
    }
    if (hay.startsWith(needle)) {
      scored.push({ item, score: 1 });
      continue;
    }
    if (hay.includes(needle)) {
      scored.push({ item, score: 2 });
      continue;
    }
    const fuzzy = subsequence(hay, needle);
    if (fuzzy !== undefined) scored.push({ item, score: 3 + fuzzy });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // On a tie the shorter candidate is the more likely intent: "/mode" beats
    // "/models" and "/model" for the token "/mo".
    if (a.item.value.length !== b.item.value.length) return a.item.value.length - b.item.value.length;
    return a.item.value.localeCompare(b.item.value);
  });
  return scored.map((entry) => entry.item);
}

/** Gap penalty of a subsequence match, or undefined when it does not match. */
function subsequence(hay: string, needle: string): number | undefined {
  let index = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = hay.indexOf(char, index);
    if (found === -1) return undefined;
    gaps += found - index;
    index = found + 1;
  }
  return gaps;
}

/**
 * Applies a completion to the line: the token under the cursor is replaced and
 * a trailing space is added, so the next completion starts on the following
 * argument. Commands and files need no space after them.
 */
export function applyCompletion(
  line: string,
  cursor: number,
  result: CompletionResult,
  chosen: Completion,
): { line: string; cursor: number } {
  const suffix = line.slice(result.end);
  const before = line.slice(0, result.start);
  const needsSpace = chosen.kind !== "file";
  const inserted = needsSpace ? `${chosen.value} ` : chosen.value;
  const next = `${before}${inserted}${suffix}`;
  return { line: next, cursor: result.start + inserted.length };
}
