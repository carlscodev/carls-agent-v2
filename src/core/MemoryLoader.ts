import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MEMORY_FILES = ["CARLS.md", "CLAUDE.md", "AGENTS.md"];

/**
 * Loads durable developer instructions from the workspace root. CARLS.md wins
 * over CLAUDE.md, which wins over AGENTS.md (first match only, to keep the
 * system prompt bounded).
 */
export class MemoryLoader {
  static load(cwd: string): { file: string; content: string } | undefined {
    for (const name of MEMORY_FILES) {
      const path = join(cwd, name);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf8").trim();
        if (content.length > 0) return { file: name, content };
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
