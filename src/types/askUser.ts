/**
 * Elicitation contract.
 *
 * The agent uses this when the request is open enough that guessing would be
 * expensive: a new project with several plausible stacks, a design with real
 * forks, or a scope that could be a weekend or a quarter. The same payload is
 * consumed by the interactive `PromptWizardBox` and by the headless resolver,
 * so a scripted test and a human see the exact same questions.
 */

export type AskUserQuestionType = "single_select" | "multi_select" | "text" | "confirm";

export interface AskUserOption {
  value: string;
  label: string;
  hint?: string | undefined;
}

export type AskUserDefault = string | string[] | boolean;

export interface AskUserQuestion {
  id: string;
  prompt: string;
  type: AskUserQuestionType;
  options?: AskUserOption[] | undefined;
  defaultValue?: AskUserDefault | undefined;
}

export interface AskUserPayload {
  title: string;
  context?: string | undefined;
  questions: AskUserQuestion[];
}

export type AskUserAnswer = string | string[] | boolean;

export interface AskUserResult {
  answers: Record<string, AskUserAnswer>;
  cancelled: boolean;
  /** True when no human was available and every answer came from a default. */
  autoSelected: boolean;
}

export type AskUserHandler = (payload: AskUserPayload) => Promise<AskUserResult>;

/** Default answer for one question, used by the headless path and as a fallback. */
export function defaultAnswerFor(question: AskUserQuestion): AskUserAnswer {
  const value = question.defaultValue;
  switch (question.type) {
    case "multi_select":
      return Array.isArray(value) ? [...value] : [];
    case "confirm":
      return typeof value === "boolean" ? value : false;
    case "text":
      return typeof value === "string" ? value : "";
    case "single_select":
      if (typeof value === "string" && value.length > 0) return value;
      return question.options?.[0]?.value ?? "";
  }
}

/**
 * Resolves a payload without a terminal. This is the contract for `-p`, CI and
 * `--yolo`: it never waits for a key, so a pipeline cannot hang on a question
 * nobody can see.
 */
export function autoResolveAskUser(payload: AskUserPayload): AskUserResult {
  const answers: Record<string, AskUserAnswer> = {};
  for (const question of payload.questions) {
    answers[question.id] = defaultAnswerFor(question);
  }
  return { answers, cancelled: false, autoSelected: true };
}

/** Human form of one answer, for the tool result the model reads. */
export function formatAskUserAnswer(question: AskUserQuestion, value: AskUserAnswer | undefined): string {
  if (value === undefined) return "(sin respuesta)";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(ninguna)";
  if (typeof value === "boolean") return value ? "sí" : "no";
  return value.length > 0 ? value : "(vacía)";
}
