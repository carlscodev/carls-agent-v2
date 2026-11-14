import type { DagSnapshot } from "./PersistentTaskDAG.js";

/**
 * Decides how much machinery a request deserves.
 *
 * Running every request through a persisted task graph would be as wrong as
 * running a week-long refactor as a single turn: the first pays planning overhead
 * for "fix this typo", the second loses the plan when the terminal closes. The
 * router's job is to pick, from signals the model can see, which of the three
 * shapes applies.
 *
 * The signals are deliberately observable rather than clever: length, how many
 * things are being asked for, and whether the wording implies a sequence. A wrong
 * guess is cheap in one direction (a medium task run as short just needs more
 * turns) and expensive in the other, so the thresholds lean toward the heavier
 * shape only when the evidence is clear.
 */

export type Horizon = "short" | "medium" | "long";

export interface HorizonDecision {
  horizon: Horizon;
  /** Why this horizon was chosen, shown to the user and put in the receipt. */
  reason: string;
  /** Signals that fired, for debugging a surprising classification. */
  signals: string[];
  /** Suggested step budget for the turn. */
  suggestedSteps: number;
}

export interface HorizonInput {
  /** The user's request. */
  goal: string;
  /** True when a persisted plan already exists and is unfinished. */
  hasActivePlan?: boolean;
}

/** Normalises accents and case for bilingual Spanish/English matching. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Words that imply an ordered, multi-part piece of work (English + Spanish). */
const SEQUENCE_MARKERS = [
  "then",
  "after that",
  "first",
  "second",
  "finally",
  "step by step",
  "pipeline",
  "refactor",
  "migrate",
  "port ",
  "rewrite",
  "audit the whole",
  "all files",
  "every file",
  "end to end",
  "end-to-end",
  "across the codebase",
  "whole project",
  "entire codebase",
  "primero",
  "segundo",
  "despues",
  "luego",
  "finalmente",
  "por ultimo",
  "paso a paso",
  "refactoriza",
  "migra",
  "reescribe",
  "audita todo",
  "todos los archivos",
  "cada archivo",
  "de punta a punta",
  "todo el proyecto",
  "todo el repositorio",
  "arquitectura completa",
];

/** Words that imply a single, local answer (English + Spanish). */
const SHORT_MARKERS = [
  "what is",
  "what does",
  "why does",
  "explain",
  "where is",
  "show me",
  "how do i",
  "rename",
  "typo",
  "one line",
  "this file",
  "que es",
  "que hace",
  "por que",
  "explica",
  "explicame",
  "donde esta",
  "muestrame",
  "como hago",
  "renombra",
  "una linea",
  "este archivo",
];

const LONG_LENGTH = 900;
const MEDIUM_LENGTH = 240;

/**
 * Counts the distinct asks in a request: list items first, then sentences, then
 * clauses joined by "and" / "and then" / "y luego" / "ademas". A request with
 * five bullets is five tasks, not one long sentence, and "update X and adjust Y"
 * is two edits that must agree — the strongest signals available without a model.
 */
export function countAsks(goal: string): number {
  const lines = goal.split(/\r?\n/).map((line) => line.trim());
  const bullets = lines.filter((line) => /^([-*+]|\d+[.)])\s+\S/.test(line)).length;
  if (bullets > 0) return bullets;

  // Clauses joined by a conjunction are separate asks; splitting on them before
  // the sentence pass is what catches "do A, and do B" written as one sentence.
  const clauses = goal
    .split(/[.;]\s+|,\s*(?:and|y|adem[aá]s)\s+|\s+(?:and\s+then|y\s+luego|y\s+despu[eé]s|adem[aá]s)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 12);
  return Math.max(1, clauses.length);
}

export class TaskHorizonRouter {
  /**
   * `activePlan` is checked first and wins outright: once a plan is running, the
   * horizon is not a fresh judgement, it is a continuation.
   */
  decide(input: HorizonInput): HorizonDecision {
    if (input.hasActivePlan === true) {
      return {
        horizon: "long",
        reason: "an unfinished task graph exists, so this turn continues it",
        signals: ["active plan on disk"],
        suggestedSteps: 60,
      };
    }

    const goal = input.goal.trim();
    const lower = normalize(goal);
    const signals: string[] = [];
    const asks = countAsks(goal);

    const sequenceHits = SEQUENCE_MARKERS.filter((marker) => lower.includes(marker));
    const shortHits = SHORT_MARKERS.filter((marker) => lower.includes(marker));

    if (asks >= 3) signals.push(`${asks} distinct asks`);
    if (goal.length >= LONG_LENGTH) signals.push(`long request (${goal.length} chars)`);
    if (sequenceHits.length > 0) signals.push(`sequence wording: ${sequenceHits.join(", ")}`);
    if (shortHits.length > 0) signals.push(`single-answer wording: ${shortHits.join(", ")}`);

    // A long horizon needs several independent signals: length alone is often just
    // a user pasting a stack trace.
    const longScore =
      (asks >= 3 ? 2 : 0) +
      (goal.length >= LONG_LENGTH ? 1 : 0) +
      (sequenceHits.length >= 2 ? 2 : sequenceHits.length === 1 ? 1 : 0);
    if (longScore >= 3) {
      return {
        horizon: "long",
        reason: "the request decomposes into dependent steps that must survive a restart",
        signals,
        suggestedSteps: 60,
      };
    }

    if (shortHits.length > 0 && asks === 1 && goal.length < MEDIUM_LENGTH) {
      return {
        horizon: "short",
        reason: "a single question or a local edit; planning would only add latency",
        signals,
        suggestedSteps: 15,
      };
    }

    if (asks >= 2 || goal.length >= MEDIUM_LENGTH || sequenceHits.length > 0) {
      return {
        horizon: "medium",
        reason: "several files or several steps, but a plan held in memory is enough",
        signals,
        suggestedSteps: 30,
      };
    }

    return {
      horizon: "short",
      reason: "a single, self-contained request",
      signals: signals.length > 0 ? signals : ["no multi-step signal"],
      suggestedSteps: 20,
    };
  }
}

/** One-line summary of a plan, for the status line and the receipt. */
export function describeSnapshot(snapshot: DagSnapshot): string {
  return `${snapshot.completed}/${snapshot.nodes.length} nodes completed, ${snapshot.failed} failed, ${snapshot.pending} pending`;
}
