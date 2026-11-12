import type { ToolSchema } from "./llm.js";
import type { ResolvedConfig } from "../config/Config.js";
import type { SessionStore } from "../core/SessionStore.js";
import type { BackupStore } from "../core/Backups.js";
import type { Logger } from "../utils/Logger.js";
import type { SkillRegistry } from "../skills/SkillRegistry.js";
import type { SubAgentRole } from "../core/SubAgent.js";
import type { SubAgentOutcome, SubAgentTask } from "../core/SubAgentPool.js";
import type { PersistentTaskDAG } from "../core/PersistentTaskDAG.js";

export interface ToolContext {
  cwd: string;
  config: ResolvedConfig;
  session: SessionStore;
  logger: Logger;
  signal: AbortSignal;
  /** Snapshot store so `/undo` can revert agent edits. */
  backups?: BackupStore;
  /** Invoked by `delegate_task` to run one isolated sub-agent loop. */
  spawnSubAgent?: (goal: string, role?: SubAgentRole) => Promise<string>;
  /** Invoked by `delegate_task` to run several sub-agents in parallel. */
  spawnSubAgentPool?: (tasks: readonly SubAgentTask[]) => Promise<SubAgentOutcome[]>;
  /** How many tasks `spawnSubAgentPool` accepts per call. */
  subAgentPoolLimit?: number;
  /** Skills the model can load with `use_skill` and extend with `save_skill`. */
  skills?: SkillRegistry;
  /** Persistent task graph, so a long plan survives a restart. */
  dag?: PersistentTaskDAG;
  /** Live-state renderer used by the compaction pipeline and the receipt. */
  buildLiveState?: () => Promise<string>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * What a tool can touch, used by the permission modes:
 * - read:  never mutates anything.
 * - write: modifies files inside the workspace.
 * - shell: runs arbitrary commands, so it is the most sensitive category.
 */
export type ToolCategory = "read" | "write" | "shell";

export interface Tool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  /** Defaults to "read" for read-only tools and "write" otherwise. */
  readonly category?: ToolCategory;
  /** JSON schema derived from the zod schema, sent to the model. */
  schema(): ToolSchema;
  /** Validates raw model input and returns a typed, safe object. */
  parse(input: unknown): I;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}
