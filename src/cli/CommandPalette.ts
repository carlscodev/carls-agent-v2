import { theme } from "./Theme.js";
import { selectList, type SelectItem } from "./SelectList.js";
import { COMMANDS } from "./Commands.js";
import type { Runtime } from "../core/Runtime.js";
import { printInfo } from "./TerminalUI.js";

/**
 * Slash-command palette.
 *
 * Typing `/` alone, or pressing Ctrl+P, opens a filterable list of every
 * command. This exists because a CLI with thirty commands is unusable from
 * memory, and the palette is also how a user discovers `/theme` or `/compact`
 * in the first place.
 */

/** Commands whose effect only makes sense once a turn has run. */
const NEEDS_HISTORY = new Set(["/undo", "/compact", "/retry", "/diff"]);

/** Builds the palette rows, newest state first so ordering stays predictable. */
export function paletteItems(runtime: Runtime): SelectItem[] {
  const items: SelectItem[] = [];
  for (const command of COMMANDS) {
    const usage = command.usage ?? command.name;
    const aliases = command.aliases !== undefined && command.aliases.length > 0
      ? ` · ${command.aliases.join(", ")}`
      : "";
    const detail = command.summary + aliases;
    const disabled = NEEDS_HISTORY.has(command.name) && runtime.history.length === 0;
    items.push({
      id: command.name,
      label: usage,
      detail: disabled ? `${detail} (nothing yet)` : detail,
      section: sectionFor(command.name),
    });
  }
  return items;
}

function sectionFor(name: string): string {
  if (["/help", "/exit"].includes(name)) return "Session";
  if (["/models", "/model", "/effort", "/mode", "/agent", "/agents"].includes(name)) return "Agent";
  if (["/status", "/cost", "/config", "/doctor", "/providers"].includes(name)) return "Diagnostics";
  if (["/undo", "/diff", "/files", "/todo", "/compact", "/clear", "/editor"].includes(name)) return "Workspace";
  if (["/sessions", "/resume", "/retry", "/init", "/setup", "/export"].includes(name)) return "Project";
  if (["/skills", "/tools"].includes(name)) return "Capabilities";
  return "Other";
}

/**
 * Opens the palette and returns the command line the user chose, or undefined if
 * they dismissed it. The caller decides what to run, so the palette stays a pure
 * view over the command registry.
 */
export async function openCommandPalette(
  runtime: Runtime,
  filter?: string,
): Promise<string | undefined> {
  const items = paletteItems(runtime);
  const choice = await selectList({
    title: `${theme().paint(theme().colors.accent, "Commands")} ${theme().paint(theme().colors.text.faint, `${items.length} available`)}`,
    items,
    ...(filter !== undefined && filter.length > 0 ? { filter } : {}),
  });
  if (choice === undefined) return undefined;
  return choice.id;
}

/** Prints a one-line nudge the first time a bare `/` is typed. */
export function printPaletteHint(): void {
  printInfo(`Opening the command palette…`);
}
