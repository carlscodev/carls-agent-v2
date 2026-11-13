import { FrameRenderer } from "./FrameRenderer.js";
import { RawSession, type KeyEvent } from "./Input.js";
import { pad, terminalDimension, truncate, visibleWidth } from "./Text.js";
import { theme } from "./Theme.js";
import {
  autoResolveAskUser,
  defaultAnswerFor,
  formatAskUserAnswer,
  type AskUserAnswer,
  type AskUserOption,
  type AskUserPayload,
  type AskUserQuestion,
  type AskUserResult,
} from "../types/askUser.js";

/**
 * Compact, keyboard-driven elicitation box.
 *
 * The UI is a pure state machine plus a pure frame builder; only `run` touches
 * the terminal. That separation is what makes the whole interaction testable:
 * a test can press ↓/Enter/Esc and assert the resulting answer map without a
 * pty, and a second test can assert that every rendered line fits the terminal.
 */

export const WIZARD_OTHER_VALUE = "__other__";

const CONFIRM_OPTIONS: AskUserOption[] = [
  { value: "yes", label: "Sí" },
  { value: "no", label: "No" },
];

export type WizardMode = "options" | "text" | "summary";

export interface WizardState {
  payload: AskUserPayload;
  index: number;
  focus: number;
  answers: Record<string, AskUserAnswer>;
  mode: WizardMode;
  input: string;
  cursor: number;
  summaryFocus: number;
  done: boolean;
  cancelled: boolean;
}

/** Visible options per question; the box stays between 7 and 12 rows. */
const MAX_VISIBLE_OPTIONS = 5;

function currentQuestion(state: WizardState): AskUserQuestion | undefined {
  return state.payload.questions[state.index];
}

/** The options the UI offers, including the always-available escape hatch. */
export function optionsFor(question: AskUserQuestion): AskUserOption[] {
  if (question.type === "confirm") return CONFIRM_OPTIONS;
  if (question.type === "text") return [];
  const options = question.options !== undefined ? [...question.options] : [];
  options.push({ value: WIZARD_OTHER_VALUE, label: "Otro (escribir respuesta...)" });
  return options;
}

function focusFor(question: AskUserQuestion, answer: AskUserAnswer): number {
  const options = optionsFor(question);
  if (question.type === "confirm") return answer === true ? 0 : 1;
  if (question.type === "single_select" && typeof answer === "string") {
    const found = options.findIndex(
      (option) => option.value !== WIZARD_OTHER_VALUE && option.value === answer,
    );
    if (found >= 0) return found;
    const other = options.findIndex((option) => option.value === WIZARD_OTHER_VALUE);
    if (other >= 0) return other;
  }
  return 0;
}

export function createWizardState(payload: AskUserPayload): WizardState {
  const answers: Record<string, AskUserAnswer> = {};
  for (const question of payload.questions) answers[question.id] = defaultAnswerFor(question);
  const first = payload.questions[0];
  const state: WizardState = {
    payload,
    index: 0,
    focus: first !== undefined ? focusFor(first, answers[first.id] ?? "") : 0,
    answers,
    mode: first?.type === "text" ? "text" : "options",
    input: first?.type === "text" ? String(answers[first.id] ?? "") : "",
    cursor: first?.type === "text" ? String(answers[first.id] ?? "").length : 0,
    summaryFocus: 0,
    done: false,
    cancelled: false,
  };
  return state;
}

/** Loads one question and restores its previous answer into the editor. */
function enterQuestion(state: WizardState, index: number): void {
  const clamped = Math.max(0, Math.min(state.payload.questions.length - 1, index));
  const question = state.payload.questions[clamped];
  if (question === undefined) return;
  state.index = clamped;
  state.focus = focusFor(question, state.answers[question.id] ?? "");
  if (question.type === "text") {
    state.mode = "text";
    state.input = String(state.answers[question.id] ?? "");
    state.cursor = state.input.length;
    return;
  }
  state.mode = "options";
  state.input = "";
  state.cursor = 0;
}

function nextQuestion(state: WizardState): void {
  if (state.index < state.payload.questions.length - 1) {
    enterQuestion(state, state.index + 1);
    return;
  }
  state.mode = "summary";
  state.summaryFocus = Math.max(0, Math.min(state.summaryFocus, state.payload.questions.length - 1));
}

function previousQuestion(state: WizardState): void {
  if (state.mode === "summary") {
    enterQuestion(state, state.payload.questions.length - 1);
    return;
  }
  if (state.index > 0) enterQuestion(state, state.index - 1);
}

/** Saves an in-progress text edit so Tab/backtracking does not lose it. */
function saveDraft(state: WizardState): void {
  if (state.mode !== "text") return;
  const question = currentQuestion(state);
  if (question === undefined || question.type === "multi_select") return;
  state.answers[question.id] = state.input;
}

function startText(state: WizardState, seed = ""): void {
  state.mode = "text";
  state.input = seed;
  state.cursor = seed.length;
}

function toggleMulti(state: WizardState, question: AskUserQuestion, focus: number): void {
  const option = optionsFor(question)[focus];
  if (option === undefined) return;
  if (option.value === WIZARD_OTHER_VALUE) {
    startText(state);
    return;
  }
  const current = Array.isArray(state.answers[question.id]) ? (state.answers[question.id] as string[]) : [];
  state.answers[question.id] = current.includes(option.value)
    ? current.filter((value) => value !== option.value)
    : [...current, option.value];
}

function commitText(state: WizardState): void {
  const question = currentQuestion(state);
  if (question === undefined) return;
  const text = state.input.trim();
  if (question.type === "multi_select") {
    if (text.length > 0) {
      const current = Array.isArray(state.answers[question.id]) ? (state.answers[question.id] as string[]) : [];
      if (!current.includes(text)) state.answers[question.id] = [...current, text];
    }
  } else {
    state.answers[question.id] = text;
  }
  nextQuestion(state);
}

function commitOption(state: WizardState): void {
  const question = currentQuestion(state);
  if (question === undefined) return;
  if (question.type === "text") {
    commitText(state);
    return;
  }
  const options = optionsFor(question);
  const option = options[state.focus];
  if (option === undefined) return;

  if (question.type === "confirm") {
    state.answers[question.id] = state.focus === 0;
    nextQuestion(state);
    return;
  }
  if (option.value === WIZARD_OTHER_VALUE) {
    startText(state);
    return;
  }
  if (question.type === "single_select") state.answers[question.id] = option.value;
  nextQuestion(state);
}

function selectFocused(state: WizardState): void {
  const question = currentQuestion(state);
  if (question === undefined) return;
  if (question.type === "text") return;
  if (question.type === "multi_select") {
    toggleMulti(state, question, state.focus);
    return;
  }
  const option = optionsFor(question)[state.focus];
  if (option === undefined) return;
  if (option.value === WIZARD_OTHER_VALUE) {
    startText(state);
    return;
  }
  state.answers[question.id] = question.type === "confirm" ? state.focus === 0 : option.value;
}

function isPrintable(sequence: string | undefined): boolean {
  if (sequence === undefined || sequence.length === 0) return false;
  if (sequence.startsWith("\u001b")) return false;
  return sequence >= " " && sequence !== "\u007f";
}

function cancel(state: WizardState): void {
  state.cancelled = true;
  state.done = true;
}

/**
 * One keystroke. Mutates `state` and returns it, which keeps the raw-mode loop
 * tiny and lets tests drive a whole questionnaire synchronously.
 */
export function reduceWizardKey(state: WizardState, key: KeyEvent): WizardState {
  if (state.done) return state;
  if (key.ctrl === true && (key.name === "c" || key.name === "d")) {
    cancel(state);
    return state;
  }
  if (key.name === "escape") {
    cancel(state);
    return state;
  }

  if (state.mode === "summary") {
    const count = state.payload.questions.length;
    if (key.name === "up" || key.name === "k") {
      state.summaryFocus = Math.max(0, state.summaryFocus - 1);
      return state;
    }
    if (key.name === "down" || key.name === "j") {
      state.summaryFocus = Math.min(count - 1, state.summaryFocus + 1);
      return state;
    }
    if (key.name === "left" || key.sequence === "\u001b[Z") {
      enterQuestion(state, Math.max(0, state.summaryFocus - 1));
      state.summaryFocus = state.index;
      return state;
    }
    if (key.name === "right") {
      enterQuestion(state, Math.min(count - 1, state.summaryFocus + 1));
      state.summaryFocus = state.index;
      return state;
    }
    if (key.name === "return" || key.name === "enter") {
      state.done = true;
      return state;
    }
    return state;
  }

  if (state.mode === "text") {
    if (key.name === "return" || key.name === "enter") {
      commitText(state);
      return state;
    }
    if (key.name === "backspace") {
      if (state.cursor > 0) {
        state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
        state.cursor -= 1;
      }
      return state;
    }
    if (key.name === "delete") {
      if (state.cursor < state.input.length) {
        state.input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1);
      }
      return state;
    }
    if (key.name === "left") {
      state.cursor = Math.max(0, state.cursor - 1);
      return state;
    }
    if (key.name === "right") {
      state.cursor = Math.min(state.input.length, state.cursor + 1);
      return state;
    }
    if (key.name === "tab" || key.sequence === "\u001b[Z") {
      saveDraft(state);
      if (key.sequence === "\u001b[Z") previousQuestion(state);
      else nextQuestion(state);
      return state;
    }
    if (isPrintable(key.sequence)) {
      const text = key.sequence as string;
      state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor);
      state.cursor += text.length;
    }
    return state;
  }

  // options mode
  const question = currentQuestion(state);
  if (question === undefined) return state;
  const options = optionsFor(question);
  const count = Math.max(1, options.length);

  if (key.name === "up" || key.name === "k") {
    state.focus = (state.focus - 1 + count) % count;
    return state;
  }
  if (key.name === "down" || key.name === "j") {
    state.focus = (state.focus + 1) % count;
    return state;
  }
  if (key.name === "left") {
    previousQuestion(state);
    return state;
  }
  if (key.name === "right") {
    nextQuestion(state);
    return state;
  }
  if (key.name === "tab" || key.sequence === "\u001b[Z") {
    if (key.sequence === "\u001b[Z") previousQuestion(state);
    else nextQuestion(state);
    return state;
  }
  if (key.name === "space" || key.sequence === " ") {
    selectFocused(state);
    return state;
  }
  if (key.name === "return" || key.name === "enter") {
    commitOption(state);
    return state;
  }
  return state;
}

/** Final answer map; unanswered questions fall back to their defaults. */
export function finishWizard(state: WizardState): AskUserResult {
  if (state.cancelled) return { answers: {}, cancelled: true, autoSelected: false };
  const answers: Record<string, AskUserAnswer> = {};
  for (const question of state.payload.questions) {
    const value = state.answers[question.id];
    if (question.type === "multi_select") {
      answers[question.id] = Array.isArray(value) ? value : [];
    } else if (question.type === "confirm") {
      answers[question.id] = typeof value === "boolean" ? value : false;
    } else {
      answers[question.id] = typeof value === "string" ? value : "";
    }
  }
  return { answers, cancelled: false, autoSelected: false };
}

/** Rows the box needs, clamped to the 7–12 range from the design brief. */
export function wizardBoxHeight(payload: AskUserPayload, maxOptions = MAX_VISIBLE_OPTIONS): number {
  let widest = 1;
  for (const question of payload.questions) {
    widest = Math.max(widest, optionsFor(question).length);
  }
  const visible = Math.max(1, Math.min(maxOptions, widest));
  return Math.max(7, Math.min(12, 6 + visible));
}

export interface WizardFrameOptions {
  width: number;
  boxHeight?: number;
  maxOptions?: number;
}

function borderTop(width: number, label: string, right: string): string {
  const safeWidth = Math.max(8, width);
  const rightText = ` ${right} ─╮`;
  const leftText = "╭─";
  const room = Math.max(0, safeWidth - visibleWidth(leftText) - visibleWidth(rightText));
  const title = truncate(` ${label} `, Math.max(0, room - 1));
  const dashes = Math.max(0, room - visibleWidth(title));
  return `${leftText}${title}${"─".repeat(dashes)}${rightText}`;
}

function borderBottom(width: number): string {
  return `╰${"─".repeat(Math.max(0, Math.max(8, width) - 2))}╯`;
}

function paddedContent(text: string, width: number): string {
  const inner = Math.max(0, Math.max(8, width) - 4);
  return `│ ${pad(truncate(text, inner), inner)} │`;
}

function answerValue(state: WizardState, question: AskUserQuestion): AskUserAnswer {
  return state.answers[question.id] ?? defaultAnswerFor(question);
}

/**
 * Pure frame builder. Every returned line is exactly `width` visible columns,
 * so a terminal can never wrap the box and corrupt the rows below it.
 */
export function buildWizardFrame(state: WizardState, options: WizardFrameOptions): string[] {
  const t = theme();
  const width = Math.max(8, Math.floor(options.width));
  const boxHeight = options.boxHeight ?? wizardBoxHeight(state.payload, options.maxOptions);
  const maxOptions = options.maxOptions ?? MAX_VISIBLE_OPTIONS;
  const accent = (text: string): string => t.paint(t.colors.accent, text);
  const faint = (text: string): string => t.paint(t.colors.text.faint, text);
  const muted = (text: string): string => t.paint(t.colors.text.muted, text);

  const summary = state.mode === "summary";
  const right = summary ? "[Resumen]" : `[Pregunta ${state.index + 1}/${state.payload.questions.length}]`;
  const lines: string[] = [borderTop(width, state.payload.title, right)];

  if (summary) {
    const visibleRows = Math.max(1, boxHeight - 3);
    const start = Math.max(0, Math.min(state.summaryFocus - Math.floor(visibleRows / 2), state.payload.questions.length - visibleRows));
    const slice = state.payload.questions.slice(start, start + visibleRows);
    for (let offset = 0; offset < slice.length; offset++) {
      const question = slice[offset];
      if (question === undefined) continue;
      const active = start + offset === state.summaryFocus;
      const marker = active ? accent("❯") : " ";
      const value = formatAskUserAnswer(question, answerValue(state, question));
      lines.push(paddedContent(`${marker} ${question.id}: ${value}`, width));
    }
  } else {
    const question = currentQuestion(state);
    if (question !== undefined) {
      lines.push(paddedContent(question.prompt, width));
      lines.push(paddedContent(state.payload.context !== undefined ? faint(state.payload.context) : "", width));
      lines.push(paddedContent("", width));

      if (state.mode === "text") {
        const before = state.input.slice(0, state.cursor);
        const after = state.input.slice(state.cursor);
        const caret = accent("│");
        const placeholder = state.input.length === 0 ? faint(" (escribe tu respuesta)") : "";
        lines.push(paddedContent(`${accent("❯")} ${before}${caret}${after}${placeholder}`, width));
      } else {
        const optionsList = optionsFor(question);
        const visible = Math.max(1, Math.min(maxOptions, optionsList.length));
        const start = Math.max(
          0,
          Math.min(state.focus - Math.floor(visible / 2), Math.max(0, optionsList.length - visible)),
        );
        const answer = answerValue(state, question);
        for (let offset = 0; offset < visible; offset++) {
          const index = start + offset;
          const option = optionsList[index];
          if (option === undefined) continue;
          const active = index === state.focus;
          const marker = active ? accent("❯") : " ";
          let bullet: string;
          if (question.type === "multi_select") {
            const selected = Array.isArray(answer) && answer.includes(option.value);
            bullet = selected ? accent("☑") : muted("☐");
          } else {
            const selected =
              question.type === "confirm"
                ? (option.value === "yes" && answer === true) || (option.value === "no" && answer === false)
                : typeof answer === "string" && answer === option.value;
            bullet = selected ? accent("●") : muted("○");
          }
          const hint = option.hint !== undefined ? faint(`  (${option.hint})`) : "";
          lines.push(paddedContent(`${marker} ${bullet} ${option.label}${hint}`, width));
        }
      }
    }
  }

  // Pad to the fixed height so the dock never jumps as questions change shape.
  // The footer and the bottom border are the last two rows, so the content area
  // ends at `boxHeight - 2`.
  while (lines.length < boxHeight - 2) lines.push(paddedContent("", width));
  if (lines.length > boxHeight - 2) lines.length = boxHeight - 2;

  const footer = summary
    ? "[Enter] Enviar  [←/→] Revisar  [Esc] Cancelar"
    : state.mode === "text"
      ? "[Enter] Confirmar  [←/→] Cursor  [Tab] Sig/Ant  [Esc] Cancelar"
      : `[↑/↓] Mover  [Espacio/Enter] Seleccionar  [Tab] Sig/Ant  [Esc] Saltar${
          currentQuestion(state) !== undefined && currentQuestion(state)?.type !== "text"
            ? faint(`  · ${state.focus + 1}/${optionsFor(currentQuestion(state) as AskUserQuestion).length}`)
            : ""
        }`;
  lines.push(paddedContent(footer, width));
  lines.push(borderBottom(width));
  return lines;
}

export interface PromptWizardRunOptions {
  payload: AskUserPayload;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** 1-based row for the top border. Defaults to the bottom dock. */
  originRow?: number;
  /** Override the terminal width, mainly for tests. */
  width?: number;
  /** Override the box height, mainly for tests. */
  boxHeight?: number;
}

/**
 * Runs the box on a real terminal. No TTY means no question: the caller gets
 * the default answers immediately, which is what keeps `-p` and CI unblocked.
 */
export class PromptWizardBox {
  static async run(options: PromptWizardRunOptions): Promise<AskUserResult> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stderr;
    if (input.isTTY !== true || output.isTTY !== true) {
      return autoResolveAskUser(options.payload);
    }

    const state = createWizardState(options.payload);
    const width = options.width ?? Math.max(16, terminalDimension(output.columns, 80));
    const boxHeight = options.boxHeight ?? wizardBoxHeight(options.payload);
    const rows = output.rows !== undefined && output.rows > 0 ? output.rows : 24;
    const originRow = options.originRow ?? Math.max(1, rows - boxHeight - 1);
    const frame = new FrameRenderer(output, { coalesce: false });
    const draw = (): void => {
      frame.render(buildWizardFrame(state, { width, boxHeight }), { originRow });
    };

    try {
      draw();
      await RawSession.with(input, async (next) => {
        while (!state.done) {
          const key = await next();
          reduceWizardKey(state, key);
          draw();
        }
      });
      return finishWizard(state);
    } finally {
      frame.clear();
      frame.dispose();
    }
  }
}
