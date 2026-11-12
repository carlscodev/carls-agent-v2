import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";

const inputSchema = z.object({
  todos: z
    .array(
      z.object({
        title: z.string().describe("Short, imperative description of the task."),
        status: z.enum(["pending", "in_progress", "done"]).describe("Current state of the task."),
      }),
    )
    .describe("The complete task list, replacing any previous one."),
});

type Input = z.infer<typeof inputSchema>;

/**
 * Lets the model keep an explicit plan it can update as it works. The list is
 * echoed to the terminal so the user sees progress, and kept in memory so
 * `/todo` can print it again.
 */
export class TodoWrite implements Tool<Input> {
  readonly name = "todo_write";
  readonly description =
    "Record or update the plan for the current task. Send the complete list each time; it replaces the previous one. Use it for multi-step work so progress stays visible.";
  readonly readOnly = true;
  readonly category = "read" as const;

  /** Latest list, shared through the process for /todo. */
  static current: { title: string; status: string }[] = [];

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(inputSchema),
    };
  }

  parse(input: unknown): Input {
    return inputSchema.parse(input);
  }

  async run(input: Input, ctx: ToolContext): Promise<ToolResult> {
    TodoWrite.current = input.todos.map((todo) => ({ title: todo.title, status: todo.status }));
    const marks: Record<string, string> = { pending: "☐", in_progress: "▶", done: "☑" };
    const lines = TodoWrite.current.map((todo) => `${marks[todo.status] ?? "☐"} ${todo.title}`);
    ctx.logger.debug(`plan updated (${input.todos.length} items)`);
    return {
      ok: true,
      output: `Plan updated:\n${lines.join("\n")}`,
      metadata: { items: input.todos.length },
    };
  }
}
