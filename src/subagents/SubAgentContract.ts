/**
 * Sub-agent contract.
 *
 * The model contributes interpretation; the harness contributes observation. A
 * child must not be able to claim it modified files or passed verification when
 * it only has read-only tools. Keeping the two halves separate makes the report
 * auditable and lets the parent aggregate real token and time costs.
 */

export interface SubAgentModelReport {
  summary: string;
  findings: string[];
  relevantFiles: string[];
  suggestedCommands: string[];
}

export interface SubAgentObserved {
  filesModified: string[];
  commandsExecuted: string[];
  verificationPassed: boolean;
  verificationEvidence: string[];
  tokensUsed: number;
  durationMs: number;
}

export type SubAgentContractResult = SubAgentModelReport & SubAgentObserved;

/** Fills the observed fields from the harness, never from model prose. */
export function buildSubAgentContract(
  model: SubAgentModelReport,
  observed: SubAgentObserved,
): SubAgentContractResult {
  return {
    summary: model.summary,
    findings: [...model.findings],
    relevantFiles: [...model.relevantFiles],
    suggestedCommands: [...model.suggestedCommands],
    filesModified: [...observed.filesModified],
    commandsExecuted: [...observed.commandsExecuted],
    verificationPassed: observed.verificationPassed,
    verificationEvidence: [...observed.verificationEvidence],
    tokensUsed: Math.max(0, Math.round(observed.tokensUsed)),
    durationMs: Math.max(0, Math.round(observed.durationMs)),
  };
}

/** Parses a child reply or a pool payload, defaulting the observed half. */
export function parseSubAgentContract(text: string): SubAgentContractResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<SubAgentContractResult>;
      return buildSubAgentContract(
        {
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
          relevantFiles: Array.isArray(parsed.relevantFiles) ? parsed.relevantFiles.map(String) : [],
          suggestedCommands: Array.isArray(parsed.suggestedCommands)
            ? parsed.suggestedCommands.map(String)
            : [],
        },
        {
          filesModified: Array.isArray(parsed.filesModified) ? parsed.filesModified.map(String) : [],
          commandsExecuted: Array.isArray(parsed.commandsExecuted) ? parsed.commandsExecuted.map(String) : [],
          verificationPassed: parsed.verificationPassed === true,
          verificationEvidence: Array.isArray(parsed.verificationEvidence)
            ? parsed.verificationEvidence.map(String)
            : [],
          tokensUsed: typeof parsed.tokensUsed === "number" ? parsed.tokensUsed : 0,
          durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
        },
      );
    } catch {
      // fall through to plain-text wrapping
    }
  }
  return buildSubAgentContract(
    {
      summary: text.trim().slice(0, 4000),
      findings: [],
      relevantFiles: [],
      suggestedCommands: [],
    },
    {
      filesModified: [],
      commandsExecuted: [],
      verificationPassed: false,
      verificationEvidence: [],
      tokensUsed: 0,
      durationMs: 0,
    },
  );
}

/** One compact block for the parent model; observed facts lead. */
export function formatSubAgentContract(result: SubAgentContractResult): string {
  const parts = [
    `summary: ${result.summary || "(no summary)"}`,
    `observed: ${result.verificationPassed ? "verification passed" : "no verification"} · ${result.durationMs}ms · ${result.tokensUsed} tokens`,
  ];
  if (result.filesModified.length > 0) parts.push(`files modified: ${result.filesModified.join(", ")}`);
  if (result.commandsExecuted.length > 0) parts.push(`commands: ${result.commandsExecuted.join(" | ")}`);
  if (result.findings.length > 0) parts.push(`findings:\n${result.findings.map((finding) => `  - ${finding}`).join("\n")}`);
  if (result.relevantFiles.length > 0) parts.push(`files: ${result.relevantFiles.join(", ")}`);
  return parts.join("\n");
}
