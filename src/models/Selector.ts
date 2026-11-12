import pc from "picocolors";
import type { Effort } from "../config/Config.js";
import { EFFORTS } from "../config/Config.js";
import type { ModelInfo } from "./Catalog.js";
import { type KeyEvent } from "../cli/Input.js";
import { selectList } from "../cli/SelectList.js";

export interface ModelChoice {
  model: string;
  /** Undefined means effort is off for this model. */
  effort: Effort | undefined;
}

export interface SelectOptions {
  current?: string;
  currentEffort?: Effort;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  filter?: string;
}

function tagsOf(model: ModelInfo): string[] {
  const tags: string[] = [];
  if (model.free) tags.push(pc.green("free"));
  if (model.reasoning) tags.push(pc.magenta("reasoning"));
  if (model.contextWindow !== undefined) tags.push(pc.gray(`${Math.round(model.contextWindow / 1000)}k`));
  return tags;
}

/** One-shot, non-interactive listing (used when stdin is not a TTY). */
export function renderModelList(models: ModelInfo[], current?: string, effort?: Effort): void {
  const out = process.stdout;
  out.write(
    `${pc.bold("Models")} ${pc.gray(`(${models.length})`)}` +
      (effort !== undefined ? ` ${pc.gray("· effort")} ${pc.magenta(effort)}` : "") +
      "\n",
  );
  for (const model of models) {
    const marker = model.id === current ? pc.cyan("▸") : " ";
    const tags = tagsOf(model);
    out.write(`${marker} ${model.id}${tags.length > 0 ? ` ${pc.gray("[")}${tags.join(pc.gray(" · "))}${pc.gray("]")}` : ""}\n`);
  }
  if (models.length === 0) out.write(`${pc.gray("No models returned by the endpoint.")}\n`);
}

/** Cycles through off → minimal → low → medium → high → off. */
function stepEffort(current: Effort | undefined, direction: number): Effort | undefined {
  const ring: (Effort | undefined)[] = [undefined, ...EFFORTS];
  const at = ring.indexOf(current);
  return ring[(at + direction + ring.length) % ring.length];
}

function effortLine(effort: Effort | undefined, supported: boolean): string {
  const values = EFFORTS.map((value) =>
    value === effort ? pc.magenta(`[${value}]`) : pc.gray(value),
  ).join(pc.gray(" · "));
  const shown = effort === undefined ? `${pc.gray("off")} ${pc.gray("·")} ${values}` : `${values}`;
  const note = supported
    ? ""
    : pc.gray("  (this model ignores effort; pick a reasoning model to apply it)");
  return `effort    ${shown}${note}`;
}

/** Groups model ids by their `vendor/` prefix so the picker can collapse them. */
function sectionOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "other";
}

/**
 * Interactive model picker. Returns undefined when cancelled or when stdin is
 * not a TTY, so the caller can fall back to printing the list.
 */
export async function selectModel(
  models: ModelInfo[],
  options: SelectOptions = {},
): Promise<ModelChoice | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const current = models.find((model) => model.id === options.current);
  let effort: Effort | undefined = options.currentEffort;

  const items = models.map((model) => ({
    id: model.id,
    label: model.id,
    detail: tagsOf(model).join(pc.gray(" · ")),
    section: sectionOf(model.id),
    preview: [
      `context  ${model.contextWindow !== undefined ? `${Math.round(model.contextWindow / 1000)}k` : "unknown"}`,
      `effort   ${model.reasoning === true ? "supported" : "ignored by this model"}`,
    ],
  }));

  const chosen = await selectList({
    title: "Models",
    items,
    input,
    output,
    ...(options.current !== undefined ? { current: options.current } : {}),
    ...(options.filter !== undefined && options.filter.length > 0 ? { filter: options.filter } : {}),
    status: () => effortLine(effort, current?.reasoning === true),
    extraHint: "tab effort",
    // Left/right stay bound to section collapsing, so effort uses Tab, the same
    // key family that cycles the mode in the REPL. Any printable key must reach
    // the filter, so no letter is bound here.
    onKey: (key) => {
      if (key.name !== "tab") return false;
      effort = stepEffort(effort, key.sequence === "\u001b[Z" ? -1 : 1);
      return true;
    },
  });

  if (chosen === undefined) return undefined;
  return { model: chosen.id, effort };
}

export type { KeyEvent };
