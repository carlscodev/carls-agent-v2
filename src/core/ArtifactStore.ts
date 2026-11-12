import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Offloads large tool output to disk and hands the model a pointer.
 *
 * Layer 1 of the compaction pipeline. A `bash` call that prints a 400-line test
 * failure or a `read_file` of a generated file costs thousands of tokens that the
 * model usually needs for a few seconds and then never again — but occasionally
 * it needs one line of it back. Deleting the output loses the second case;
 * keeping it in context loses the first. Writing it to a file keeps both: the
 * observation becomes a short summary plus a path, and the model can read any
 * page of it later with the ordinary file tools.
 */

export interface ArtifactRef {
  /** Stable content hash, also the file name stem. */
  hash: string;
  path: string;
  bytes: number;
  lines: number;
}

export interface ArtifactStoreOptions {
  /** Directory to write into, normally `<cwd>/.carls/artifacts`. */
  dir: string;
  /** Outputs below this many characters stay inline. */
  thresholdChars?: number;
}

export class ArtifactStore {
  private readonly dir: string;
  private readonly thresholdChars: number;

  constructor(options: ArtifactStoreOptions) {
    this.dir = options.dir;
    this.thresholdChars = options.thresholdChars ?? 8000;
  }

  get directory(): string {
    return this.dir;
  }

  /** True when this output is large enough to be worth offloading. */
  shouldOffload(text: string): boolean {
    return text.length >= this.thresholdChars;
  }

  /**
   * Writes the full text and returns a reference. Identical output maps to the
   * same file, so a test command run twice does not double the disk usage.
   */
  offload(text: string): ArtifactRef | undefined {
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const path = join(this.dir, `${hash}.txt`);
    const lines = text.split(/\r?\n/).length;
    try {
      mkdirSync(this.dir, { recursive: true });
      if (!existsSync(path)) writeFileSync(path, text, "utf8");
      return { hash, path, bytes: Buffer.byteLength(text, "utf8"), lines };
    } catch {
      // An unwritable workspace must not fail the tool call; the caller keeps the
      // truncated text instead.
      return undefined;
    }
  }

  /** Reads back a page of an artifact, 1-based and inclusive. */
  read(ref: ArtifactRef, startLine: number, endLine: number): string {
    const all = readFileSync(ref.path, "utf8").split(/\r?\n/);
    const from = Math.max(1, startLine);
    const to = Math.min(all.length, endLine);
    return all.slice(from - 1, to).join("\n");
  }

  /**
   * The observation the model sees instead of the raw output: the head, the tail,
   * and a pointer. Keeping both ends matters because the most useful line in a
   * long test failure is usually at the bottom, while the command echo is at the
   * top.
   */
  summarize(text: string, ref: ArtifactRef, headLines = 12, tailLines = 12): string {
    const lines = text.split(/\r?\n/);
    if (lines.length <= headLines + tailLines + 4) {
      return text;
    }
    const head = lines.slice(0, headLines).join("\n");
    const tail = lines.slice(-tailLines).join("\n");
    const omitted = lines.length - headLines - tailLines;
    return [
      head,
      "",
      `[output truncated: ${omitted} more line(s), ${ref.bytes} bytes total]`,
      `[full output saved to ${ref.path} — read it with read_file(path, start_line, end_line) or grep_search]`,
      "",
      tail,
    ].join("\n");
  }
}
