/**
 * Anti-hallucination evidence gate.
 *
 * A model that writes a file and then says "done" without running anything is
 * the most expensive failure mode: the operator trusts a green claim about code
 * that has never been compiled. The gate only fires when all three facts line up
 * — a write, a success claim, and no real verification after that write — and it
 * fires at most once per turn so a stubborn model cannot loop forever.
 */

export interface EvidenceSnapshot {
  pendingWrites: number;
  lastWriteAt: number;
  lastVerificationAt: number;
}

export class EvidenceTracker {
  private pending = 0;
  private writeAt = 0;
  private verificationAt = 0;

  recordWrite(_toolName: string): void {
    this.pending += 1;
    this.writeAt = Date.now();
  }

  recordVerification(_command: string): void {
    this.pending = 0;
    this.verificationAt = Date.now();
  }

  get pendingWrites(): number {
    return this.pending;
  }

  get lastWriteAt(): number {
    return this.writeAt;
  }

  get lastVerificationAt(): number {
    return this.verificationAt;
  }

  snapshot(): EvidenceSnapshot {
    return {
      pendingWrites: this.pending,
      lastWriteAt: this.writeAt,
      lastVerificationAt: this.verificationAt,
    };
  }
}

/** Commands whose first executable is a real build/test/typecheck runner. */
const VERIFICATION_PATTERNS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|lint|check)\b/i,
  /^(?:npx\s+)?(?:vitest|jest|tsc)\b/i,
  /^pytest\b/i,
  /^python\s+-m\s+pytest\b/i,
  /^mypy\b/i,
  /^cargo\s+test\b/i,
  /^go\s+test\b/i,
  /^mvn\s+(?:test|verify)\b/i,
  /^gradle\w*\s+(?:test|check)\b/i,
  /^dotnet\s+test\b/i,
  /^node\s+--test\b/i,
  /^(?:make|just)\s+(?:test|check)\b/i,
  /^lsp(?:\s+diagnostics)?\b/i,
];

/** The first word that cannot be a verification, even with a convincing tail. */
const NON_VERIFICATION = /^(?:echo|printf|cat|true|false|:|rem|write-output|write-host)\b/i;

/**
 * Strips `cd dir`-style prefixes and leading environment assignments so the
 * first real executable can be inspected. A pipeline is checked segment by
 * segment; `cd x && npm test | tail` still counts because one segment is `npm test`.
 */
function commandSegments(command: string): string[] {
  return command
    .replace(/\r\n/g, "\n")
    .split(/[;&|\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function firstExecutable(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "").trim();
}

/**
 * True only for a real verification executable. `echo "tests pass"` is a string,
 * not evidence, and is rejected by name before the patterns are considered.
 */
export function isVerificationCommand(command: string): boolean {
  for (const segment of commandSegments(command)) {
    const executable = firstExecutable(segment);
    if (executable.length === 0) continue;
    if (NON_VERIFICATION.test(executable)) continue;
    if (VERIFICATION_PATTERNS.some((pattern) => pattern.test(executable))) return true;
  }
  return false;
}

/** A final answer that claims the work is complete. */
export function claimsSuccess(text: string): boolean {
  return /\b(listo|funciona|funcion[oó]|done|fixed|passing|completed?|completado|success(?:ful)?|works?)\b/i.test(text);
}

/** A final answer that admits a blocker, which makes a verification demand noise. */
export function reportsBlock(text: string): boolean {
  return /\b(blocked|no puedo|no se pudo|cannot|can't|unable|failed|fall[oó]|errors? found|error:|not working|broken)\b/i.test(text);
}

export interface EvidenceEvaluationInput extends EvidenceSnapshot {
  finalText: string;
}

export interface EvidenceEvaluation {
  trigger: boolean;
  reason?: string;
}

/**
 * The three-condition gate. It deliberately does not care how many writes there
 * were: one unverified write is enough to make a success claim unsafe.
 */
export function evaluateEvidence(input: EvidenceEvaluationInput): EvidenceEvaluation {
  if (input.pendingWrites <= 0) return { trigger: false };
  if (input.lastVerificationAt > input.lastWriteAt) return { trigger: false };
  if (!claimsSuccess(input.finalText)) return { trigger: false };
  if (reportsBlock(input.finalText)) return { trigger: false };
  return {
    trigger: true,
    reason: "the turn changed files and claims success without running a real verification after the last write",
  };
}

/** Corrective observation injected once when the gate fires. */
export const EVIDENCE_CORRECTION =
  "[SISTEMA]: Evidence gate: este turno escribió archivos y afirmó que funciona sin ejecutar una verificación real después del último cambio. No cierres el turno todavía: ejecuta npm test, npm run typecheck, tsc, pytest, cargo test, go test o lsp diagnostics sobre lo que cambiaste y reporta la salida real. Un `echo \"tests pass\"` no cuenta como evidencia.";
