import { charsForTokens, estimateTokens } from "../utils/tokens.js";

/**
 * Head + tail budget for tool observations.
 *
 * A test runner's verdict lives at the end of its output; a file's imports and
 * signatures live at the beginning. Truncating only the tail loses the verdict,
 * and truncating only the head loses the error. The budget keeps both ends and
 * replaces the middle with an explicit, actionable marker.
 */

export type ToolBudgetCategory = "read" | "bash" | "mcp" | "write";

/** Token ceilings from the Phase 14 brief. */
export const TOOL_TOKEN_BUDGETS: Readonly<Record<ToolBudgetCategory, number>> = {
  read: 4_000,
  bash: 3_000,
  mcp: 3_500,
  write: 2_000,
};

export interface ToolBudgetOptions {
  toolName: string;
  category?: string | undefined;
  /** Model context window, used to scale the ceiling down on small models. */
  modelWindow?: number | undefined;
  /** Test/advanced override; wins over the category ceiling. */
  maxTokens?: number | undefined;
}

export interface ToolBudgetResult {
  text: string;
  truncated: boolean;
  budgetTokens: number;
  omittedLines: number;
  omittedTokens: number;
  headLines: number;
  tailLines: number;
}

/** Map a tool name/category to the budget family. */
export function budgetCategoryFor(toolName: string, category?: string): ToolBudgetCategory {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (category === "shell" || toolName === "bash") return "bash";
  if (category === "write") return "write";
  return "read";
}

/** Ceiling in tokens, never above the brief and never below 512. */
export function tokenBudgetFor(options: ToolBudgetOptions): number {
  if (options.maxTokens !== undefined) return Math.max(1, Math.floor(options.maxTokens));
  const category = budgetCategoryFor(options.toolName, options.category);
  const base = TOOL_TOKEN_BUDGETS[category];
  const window = options.modelWindow ?? 0;
  if (window <= 0) return base;
  // Do not let a single observation eat more than a tenth of the window.
  return Math.max(512, Math.min(base, Math.floor(window * 0.1)));
}

function takeHead(lines: readonly string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (out.length > 0 && used + cost > maxChars) break;
    if (out.length === 0 && cost > maxChars) {
      out.push(line.slice(0, Math.max(1, maxChars)));
      break;
    }
    out.push(line);
    used += cost;
  }
  return out;
}

function takeTail(lines: readonly string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    const cost = line.length + 1;
    if (out.length > 0 && used + cost > maxChars) break;
    if (out.length === 0 && cost > maxChars) {
      out.unshift(line.slice(-Math.max(1, maxChars)));
      break;
    }
    out.unshift(line);
    used += cost;
  }
  return out;
}

/**
 * Cuts a one- or two-line observation that has no line boundary to drop.
 *
 * A minified file, a single-line JSON blob or a long one-row error has no middle
 * line to remove, so the line-based pass below finds nothing to omit and would
 * hand the whole thing to the model. Cutting by characters keeps the head (the
 * signature, the start of the payload) and the tail (the verdict, the closing
 * brace) and states how much was dropped.
 */
function truncateByChars(text: string, budgetTokens: number): ToolBudgetResult {
  const budgetChars = charsForTokens(budgetTokens);
  let headChars = Math.max(1, Math.floor(budgetChars * 0.6));
  let tailChars = Math.max(0, Math.floor(budgetChars * 0.3));

  const build = (head: number, tail: number): string => {
    const headPart = text.slice(0, head);
    const tailPart = tail > 0 ? text.slice(text.length - tail) : "";
    const omitted = Math.max(0, text.length - headPart.length - tailPart.length);
    const marker =
      `… [${omitted} character${omitted === 1 ? "" : "s"} / ~${estimateTokens("x".repeat(omitted))} tokens omitted · ` +
      "read_file (start_line/end_line) or grep_search to inspect] …";
    return `${headPart}${marker}${tailPart}`;
  };

  // The marker has a cost of its own; halve the tail, then the head, until the
  // rendered observation respects its ceiling. The bound is a safety net: each
  // step at least halves a window, so it terminates well before it.
  let result = build(headChars, tailChars);
  let guard = 0;
  while (estimateTokens(result) > budgetTokens && guard++ < 64) {
    if (tailChars > 1) tailChars = Math.floor(tailChars / 2);
    else if (headChars > 1) headChars = Math.floor(headChars / 2);
    else break;
    result = build(headChars, tailChars);
  }

  const omitted = Math.max(0, text.length - headChars - tailChars);
  return {
    text: result,
    truncated: true,
    budgetTokens,
    omittedLines: 0,
    omittedTokens: estimateTokens("x".repeat(omitted)),
    headLines: 1,
    tailLines: tailChars > 0 ? 1 : 0,
  };
}

/**
 * Applies the category budget. Text under the ceiling is returned untouched;
 * larger text is cut to 60% head + 30% tail and an explicit middle marker.
 */
export function applyToolTokenBudget(text: string, options: ToolBudgetOptions): ToolBudgetResult {
  const budgetTokens = tokenBudgetFor(options);
  const lines = text.split("\n");
  const totalTokens = estimateTokens(text);
  if (totalTokens <= budgetTokens) {
    return {
      text,
      truncated: false,
      budgetTokens,
      omittedLines: 0,
      omittedTokens: 0,
      headLines: lines.length,
      tailLines: 0,
    };
  }

  // One or two lines cannot leave a middle for the line-based pass to remove, so
  // an oversized one (a minified file, a one-line JSON) is cut by characters.
  if (lines.length <= 2) return truncateByChars(text, budgetTokens);

  const headChars = charsForTokens(Math.max(1, Math.floor(budgetTokens * 0.6)));
  const tailChars = charsForTokens(Math.max(1, Math.floor(budgetTokens * 0.3)));
  let headCount = takeHead(lines, headChars).length;
  let tailCount = takeTail(lines, tailChars).length;
  // Never let the two windows overlap; the marker must describe a real middle.
  if (headCount + tailCount >= lines.length) {
    tailCount = Math.max(0, lines.length - headCount - 1);
  }

  const build = (head: number, tail: number): string => {
    const omitted = lines.slice(head, lines.length - tail);
    const omittedTokens = estimateTokens(omitted.join("\n"));
    const marker =
      `… [${omitted.length} line${omitted.length === 1 ? "" : "s"} / ~${omittedTokens} tokens omitted · ` +
      "read_file (start_line/end_line) or grep_search to inspect] …";
    return [...lines.slice(0, head), marker, ...lines.slice(lines.length - tail)].join("\n");
  };

  let result = build(headCount, tailCount);
  // The marker has a cost too; shrink the tail first, then the head, until the
  // rendered observation respects its ceiling.
  while (estimateTokens(result) > budgetTokens && tailCount > 1) {
    tailCount -= 1;
    result = build(headCount, tailCount);
  }
  while (estimateTokens(result) > budgetTokens && headCount > 1) {
    headCount -= 1;
    result = build(headCount, tailCount);
  }

  const omittedLines = Math.max(0, lines.length - headCount - tailCount);
  const omittedTokens = estimateTokens(lines.slice(headCount, lines.length - tailCount).join("\n"));
  return {
    text: result,
    truncated: true,
    budgetTokens,
    omittedLines,
    omittedTokens,
    headLines: headCount,
    tailLines: tailCount,
  };
}
