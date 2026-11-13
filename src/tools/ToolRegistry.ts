import type { ToolSchema } from "../types/llm.js";
import type { Tool } from "../types/tools.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => tool.schema());
  }

  /**
   * Returns a registry exposing only `names`.
   *
   * Small local models cannot hold 48 tool schemas in context; the block alone
   * is ~3.2k tokens, which is most of a default Ollama window. The restricted
   * registry still *runs* every tool, it only narrows what is advertised, so a
   * tool the model calls from memory keeps working.
   */
  restrictedTo(names: string[]): ToolRegistry {
    const registry = new ToolRegistry();
    const wanted = new Set(names);
    for (const tool of this.list()) {
      if (wanted.has(tool.name)) registry.register(tool);
    }
    return registry;
  }

  /**
   * Drops tools whose schema is the most expensive, keeping the ones an agent
   * needs to read, edit and verify code. Used when a local model is detected and
   * the user has not chosen a set explicitly.
   */
  coreToolset(): ToolRegistry {
    return this.restrictedTo(CORE_TOOLS.filter((name) => this.has(name)));
  }

  /** Removes every non-read-only tool (used to enforce plan mode at the source). */
  readOnlyOnly(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of this.list()) {
      if (tool.readOnly) registry.register(tool);
    }
    return registry;
  }
}

/**
 * The gather-act-verify essentials. Browser, clipboard, git and the long tail of
 * file helpers are left out; they stay callable but are not advertised, which is
 * what keeps the prompt small enough for a 7B model.
 */
export const CORE_TOOLS: string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "glob_files",
  "grep_search",
  "bash",
  "todo_write",
  // A local model still needs the one sanctioned way to ask before guessing.
  "ask_user",
];
