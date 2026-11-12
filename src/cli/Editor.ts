import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * External editor handoff.
 *
 * A long prompt is a document, not a line: quoting a stack trace into a
 * single-line prompt editor is the wrong tool. `/editor` writes what is typed so
 * far to a temp file, opens `$VISUAL`/`$EDITOR` on it, and hands the saved text
 * back to the prompt.
 */

export interface EditorSpec {
  command: string;
  args: string[];
}

/**
 * The editor to use, in the order a terminal respects it: an explicit
 * `CARLS_EDITOR`, then `VISUAL`, then `EDITOR`. Windows falls back to notepad,
 * which is always present; elsewhere no default is guessed.
 */
export function editorSpec(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EditorSpec | undefined {
  const raw = [env.CARLS_EDITOR, env.VISUAL, env.EDITOR].find(
    (value) => value !== undefined && value.trim().length > 0,
  );
  if (raw === undefined) {
    return platform === "win32" ? { command: "notepad", args: [] } : undefined;
  }
  const parts = raw.trim().split(/\s+/);
  const [command, ...args] = parts;
  return command === undefined || command.length === 0 ? undefined : { command, args };
}

export interface ComposeOptions {
  initial: string;
  spec?: EditorSpec | undefined;
  /** Editor processes can hang; the wait is bounded. */
  timeoutMs?: number;
}

export interface ComposeResult {
  text: string;
  /** False when the editor was closed without saving anything new. */
  changed: boolean;
  /** Set when the editor could not run at all. */
  error?: string;
}

/** Runs the editor on a temp file and returns what it saved. */
export async function composeInEditor(options: ComposeOptions): Promise<ComposeResult> {
  const spec = options.spec ?? editorSpec();
  if (spec === undefined) {
    return { text: options.initial, changed: false, error: "no editor is configured" };
  }
  const dir = mkdtempSync(join(tmpdir(), "carls-editor-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, options.initial, "utf8");
  try {
    const code = await new Promise<number>((resolve) => {
      const child = spawn(spec.command, [...spec.args, file], { stdio: "inherit", shell: false });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(1);
      }, options.timeoutMs ?? 15 * 60_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(1);
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(status ?? 1);
      });
    });
    if (code !== 0) {
      return { text: options.initial, changed: false, error: `${spec.command} exited with code ${code}` };
    }
    const text = readFileSync(file, "utf8");
    return { text, changed: text !== options.initial };
  } catch (error) {
    return { text: options.initial, changed: false, error: (error as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
