import type { Message } from "./llm.js";

export interface AgentState {
  sessionId: string;
  step: number;
  maxSteps: number;
  planMode: boolean;
  history: Message[];
  goal: string;
  filesTouched: Set<string>;
  errorsResolved: string[];
}

export interface AgentRunResult {
  steps: number;
  finalText: string;
  stoppedReason: "completed" | "max_steps" | "aborted" | "error";
}

export interface Checkpoint {
  goal: string;
  filesTouched: string[];
  errorsResolved: string[];
  summary: string;
  nextStep: string;
}
