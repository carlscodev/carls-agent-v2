/**
 * Reads what an operator's mid-run message actually wants.
 *
 * While the agent works, a human types short things: "no, use the other API",
 * "stop", "ok keep going", "why did you delete that?". Treating all of them the
 * same way is the mistake this classifier exists to avoid. A correction must
 * interrupt and change course; an approval must not restart anything; a question
 * must be answered without abandoning the plan.
 *
 * The classification is rule-based and deliberately conservative: when nothing
 * matches, the message is treated as a steering instruction, which is the safe
 * default because it lets the human redirect the work.
 */

export type SteeringIntent = "correct" | "reject" | "approve" | "question" | "steer" | "stop";

export interface SteeringDecision {
  intent: SteeringIntent;
  /** True when the current approach must be abandoned, not merely adjusted. */
  interrupts: boolean;
  /** True when the message should reach the model as an instruction. */
  forward: boolean;
  /** A short, imperative restatement for the model, when one helps. */
  instruction: string;
  /** Signals that produced the decision, for debugging a surprise. */
  signals: string[];
}

/** Words that mean "you are going the wrong way", not "carry on". */
const CORRECTION_MARKERS = [
  "no,",
  "no ",
  "not that",
  "wrong",
  "instead",
  "don't",
  "do not",
  "stop doing",
  "shouldn't",
  "should not",
  "that's not",
  "thats not",
  "i meant",
  "actually",
  "revert",
  "undo that",
  "use the other",
];

/** Words that abandon the task entirely. */
const STOP_MARKERS = ["stop", "cancel", "abort", "halt", "never mind", "nevermind", "forget it", "quit"];

/** Words that permit continuation. */
const APPROVAL_MARKERS = ["yes", "ok", "okay", "go ahead", "continue", "proceed", "looks good", "lgtm", "perfect", "correct", "right", "sounds good", "do it"];

/** A question mark anywhere, or an interrogative opener. */
const QUESTION_MARKERS = ["why ", "how ", "what ", "where ", "when ", "which ", "who ", "did you", "are you", "can you explain", "explain why"];

export class AutoReviewSteeringClassifier {
  /**
   * Classifies a message.
   *
   * Order matters. Stop is checked first because it is the one intent where a
   * false negative is expensive: if "stop" is read as steering, the agent keeps
   * working on something the human cancelled. Approval is checked before
   * correction, because "yes, that's right" contains words that appear in both
   * lists.
   */
  classify(message: string): SteeringDecision {
    const text = message.trim();
    const lower = text.toLowerCase();
    const signals: string[] = [];

    if (text.length === 0) {
      return { intent: "steer", interrupts: false, forward: false, instruction: "", signals: ["empty message"] };
    }

    const stopHits = STOP_MARKERS.filter((marker) => matchesWord(lower, marker));
    if (stopHits.length > 0) {
      signals.push(`stop wording: ${stopHits.join(", ")}`);
      return {
        intent: "stop",
        interrupts: true,
        forward: false,
        instruction: "The operator asked you to stop. Halt the current approach and report where you stopped.",
        signals,
      };
    }

    // "no, do it the other way" is a correction, but "no problem, continue" is
    // approval; the correction check needs to see a change of direction.
    const correctionHits = CORRECTION_MARKERS.filter((marker) => lower.includes(marker));
    const approvalHits = APPROVAL_MARKERS.filter((marker) => matchesWord(lower, marker));
    const hasQuestion = text.includes("?") || QUESTION_MARKERS.some((marker) => lower.startsWith(marker) || lower.includes(` ${marker}`));

    if (hasQuestion && correctionHits.length === 0 && approvalHits.length === 0) {
      signals.push("interrogative wording");
      return {
        intent: "question",
        interrupts: false,
        forward: true,
        instruction: `The operator asked a question. Answer it directly before continuing: ${text}`,
        signals,
      };
    }

    if (correctionHits.length > 0) {
      signals.push(`correction wording: ${correctionHits.slice(0, 3).join(", ")}`);
      // "don't do X" without a replacement is a rejection of the approach; with
      // one, it is a correction that redirects.
      const isRejection = /\b(don't|do not|stop doing|revert|undo that)\b/.test(lower) && !/\binstead\b|\buse\b/.test(lower);
      return {
        intent: isRejection ? "reject" : "correct",
        interrupts: true,
        forward: true,
        instruction: `The operator corrected the approach. Abandon the current line of work and follow this instead: ${text}`,
        signals,
      };
    }

    if (approvalHits.length > 0 && !hasQuestion) {
      signals.push(`approval wording: ${approvalHits.slice(0, 3).join(", ")}`);
      return {
        intent: "approve",
        interrupts: false,
        forward: false,
        instruction: "The operator approved the current direction. Continue without changing course.",
        signals,
      };
    }

    // Nothing matched: a plain instruction is a redirection.
    signals.push("no specific marker; treating as a steering instruction");
    return {
      intent: "steer",
      interrupts: true,
      forward: true,
      instruction: `The operator added an instruction. Incorporate it and continue: ${text}`,
      signals,
    };
  }
}

/**
 * Whole-word matching, so "ok" does not fire inside "token" and "stop" does not
 * fire inside "stopwatch".
 */
function matchesWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}
