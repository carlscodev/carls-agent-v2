import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import {
  autoResolveAskUser,
  formatAskUserAnswer,
  type AskUserResult,
} from "../types/askUser.js";

const optionSchema = z.object({
  value: z.string().min(1).describe("Stable id returned in the answer."),
  label: z.string().min(1).describe("Text shown to the user."),
  hint: z.string().optional().describe("One short line explaining the trade-off."),
});

const questionSchema = z
  .object({
    id: z.string().min(1).describe("Unique id used as the key in the answer map."),
    prompt: z.string().min(1).describe("The question, in the user's language."),
    type: z.enum(["single_select", "multi_select", "text", "confirm"]),
    options: z.array(optionSchema).min(1).max(12).optional(),
    defaultValue: z
      .union([z.string(), z.array(z.string()), z.boolean()])
      .optional()
      .describe("Suggested answer; the headless resolver uses it verbatim."),
  })
  .superRefine((question, ctx) => {
    const value = question.defaultValue;
    if (value === undefined) return;
    const mismatch =
      (question.type === "multi_select" && !Array.isArray(value)) ||
      (question.type !== "multi_select" && Array.isArray(value)) ||
      (question.type === "confirm" && typeof value !== "boolean") ||
      ((question.type === "single_select" || question.type === "text") && typeof value !== "string");
    if (mismatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: `defaultValue does not match a ${question.type} question.`,
      });
    }
  });

const inputSchema = z
  .object({
    title: z.string().min(1).max(80).describe("Short header for the question box."),
    context: z.string().max(200).optional().describe("One line explaining why the agent asks."),
    questions: z.array(questionSchema).min(1).max(5),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const question of value.questions) {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions"],
          message: `Duplicate question id "${question.id}".`,
        });
      }
      seen.add(question.id);
    }
  });

export type AskUserInput = z.infer<typeof inputSchema>;

/**
 * The agent's only sanctioned way to ask a human a structured question.
 *
 * It is read-only (it changes no file) but `exclusive`: while the box owns the
 * keyboard, no parallel read may take focus, and it must never be prefetched
 * while the model is still streaming the tool call.
 */
export class AskUserTool implements Tool<AskUserInput> {
  readonly name = "ask_user";
  readonly description =
    "Ask the human a small set of high-impact questions in one compact box. Use it ONLY for a new project or an open design with several plausible paths (stack/engine, visual style, core mechanics, scope); for a direct or technical request (fix a bug, run tests, rename a symbol) do not ask and act immediately. Group 2-4 questions in one call, then plan.";
  readonly readOnly = true;
  readonly category = "read" as const;
  readonly exclusive = true;

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(inputSchema),
    };
  }

  parse(input: unknown): AskUserInput {
    return inputSchema.parse(input);
  }

  async run(input: AskUserInput, ctx: ToolContext): Promise<ToolResult> {
    let result: AskUserResult;
    try {
      result = ctx.askUser !== undefined ? await ctx.askUser(input) : autoResolveAskUser(input);
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: `ask_user could not complete: ${(error as Error).message}`,
      };
    }

    const payload = {
      title: input.title,
      questions: input.questions.map((question) => question.id),
      answers: result.answers,
      cancelled: result.cancelled,
      autoSelected: result.autoSelected,
    };

    if (result.cancelled) {
      const message =
        "El usuario omitió el cuestionario; procede con las opciones recomendadas por defecto.";
      return {
        ok: true,
        output: `${message}\n\n${JSON.stringify(payload)}`,
        metadata: {
          answers: result.answers,
          cancelled: true,
          autoSelected: false,
        },
      };
    }

    const lines = input.questions.map(
      (question) => `- ${question.id}: ${formatAskUserAnswer(question, result.answers[question.id])}`,
    );
    const note = result.autoSelected
      ? "No hay humano disponible; se usaron los valores por defecto."
      : `Respuestas de ${input.questions.length} pregunta${input.questions.length === 1 ? "" : "s"}:`;
    return {
      ok: true,
      output: `${note}\n${lines.join("\n")}\n\n${JSON.stringify(payload)}`,
      metadata: {
        answers: result.answers,
        cancelled: false,
        autoSelected: result.autoSelected,
      },
    };
  }
}
