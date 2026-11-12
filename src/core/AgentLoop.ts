import type { ContentBlock, Message, Provider, ToolSchema } from "../types/llm.js";
import type { AgentRunResult } from "../types/agent.js";
import type { Checkpoint } from "../types/agent.js";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { PermissionMode } from "../config/Config.js";
import { toolCallLine, toolResultLine } from "../cli/ToolView.js";
import type { ResolvedConfig } from "../config/Config.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { PermissionGate } from "../security/PermissionGate.js";
import type { SessionStore } from "./SessionStore.js";
import type { CostTracker } from "./CostTracker.js";
import type { Hooks } from "./Hooks.js";
import type { Logger } from "../utils/Logger.js";
import { ContextManager } from "./ContextManager.js";
import { redact } from "../utils/Logger.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import pc from "picocolors";
import type { CompactionPipeline } from "./CompactionPipeline.js";

/**
 * How many independent read-only calls one assistant turn may run at once.
 * Exploration is dominated by wall-clock latency, not CPU: a turn that asks for
 * grep + five reads + two sub-agents used to pay for every one of them in
 * series. Six keeps a local endpoint and the permission gate comfortable.
 */
const MAX_PARALLEL_TOOLS = 6;

export interface AgentLoopDeps {
  provider: Provider;
  registry: ToolRegistry;
  /**
   * Registry whose schemas are advertised to the model. Defaults to `registry`.
   * Kept separate so a local model can be shown a handful of tools while every
   * tool stays executable if the model calls one anyway.
   */
  advertise?: ToolRegistry;
  gate: PermissionGate;
  contextManager: ContextManager;
  session: SessionStore;
  costTracker: CostTracker;
  hooks: Hooks;
  config: ResolvedConfig;
  logger: Logger;
  systemPrompt: string;
  /** Base context without the signal; the loop clones it per run. */
  toolContext: Omit<ToolContext, "signal">;
  /**
   * Messages typed while the turn runs. Checked at every step boundary, which
   * is the only safe place to extend the conversation: never between a
   * `tool_use` and its `tool_result`.
   */
  takeSteering?: () => string[];
  /**
   * The layered compaction pipeline. When present, the loop routes its context
   * management through it so the live state is re-anchored after a summary; when
   * absent the loop falls back to the plain `contextManager.compact`.
   */
  compaction?: CompactionPipeline;
}

export interface RunOptions {
  /** Suppress streaming/UI output (used by sub-agents). */
  silent?: boolean;
  /** Called for every assistant text delta. */
  onText?: (chunk: string) => void;
  /** Called after each tool finishes, for UI rendering. */
  onToolResult?: (name: string, result: ToolResult, durationMs: number) => void;
  /** Called when steering messages were folded into the conversation. */
  onSteer?: (messages: string[]) => void;
  /** Called at the start of every model step, for progress UI. */
  onStep?: (step: number, maxSteps: number) => void;
  /** External abort, e.g. Ctrl+C in the REPL. */
  signal?: AbortSignal;
}

export class AgentLoop {
  private readonly deps: AgentLoopDeps;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
  }

  /**
   * Swaps the client after /setup changes provider, key or base URL, so the
   * change applies to the next turn instead of needing a restart.
   */
  setProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** Narrows or widens the advertised tool set without touching execution. */
  setAdvertised(registry: ToolRegistry): void {
    this.deps.advertise = registry;
  }

  /** Replaces the system prompt, used when an agent preset is switched. */
  setSystemPrompt(prompt: string): void {
    this.deps.systemPrompt = prompt;
  }

  /** The registry whose schemas go to the model. */
  private advertised(): ToolRegistry {
    return this.deps.advertise ?? this.deps.registry;
  }

  /**
   * True when a call can run alongside the other calls of the same turn. Only
   * read-only tools qualify: a write or a shell command could change what a
   * sibling call observes, so those stay ordered and alone.
   */
  private parallelSafe(name: string): boolean {
    const tool: Tool | undefined = this.deps.registry.get(name);
    return tool !== undefined && tool.readOnly;
  }

  /**
   * Runs one tool call, renders it, and returns the observation block to feed
   * back to the model. Never throws, so a batch of parallel calls cannot reject
   * half-way and drop the results of the calls that already finished.
   */
  private async runToolUse(
    toolUse: Extract<ContentBlock, { type: "tool_use" }>,
    ctx: ToolContext,
    options: RunOptions,
    filesTouched: Set<string>,
  ): Promise<ContentBlock> {
    if (!options.silent) process.stderr.write(`\n${toolCallLine(toolUse.name, toolUse.input)}\n`);

    let result: ToolResult;
    const startedAt = Date.now();
    try {
      result = await this.executeTool(toolUse.name, toolUse.input, ctx);
    } catch (error) {
      result = { ok: false, output: "", error: `Tool ${toolUse.name} failed: ${(error as Error).message}` };
    }
    const durationMs = Date.now() - startedAt;

    if (!options.silent) process.stderr.write(`${toolResultLine(toolUse.name, result, durationMs)}\n`);
    options.onToolResult?.(toolUse.name, result, durationMs);

    if (result.ok) {
      const path = result.metadata?.path;
      if (typeof path === "string") filesTouched.add(path);
    }

    const body = result.ok
      ? result.output
      : `${result.error ?? "error"}\n${result.output}`.trim();
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: this.deps.contextManager.truncateObservation(redact(body)),
      is_error: !result.ok,
    };
  }

  /**
   * Public form of the internal summariser, so the Runtime can reuse the exact
   * same prompt for the compaction pipeline instead of a second implementation
   * that would drift from this one.
   */
  async summarizeHistory(older: Message[], hint: { goal: string; filesTouched: string[] }): Promise<Checkpoint> {
    return this.summarize(older, hint);
  }

  private async summarize(
    older: Message[],
    hint: { goal: string; filesTouched: string[] },
  ): Promise<Checkpoint> {
    const transcript = older
      .map((message) => {
        const parts = message.content.map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_use") return `tool_use ${block.name} ${JSON.stringify(block.input)}`;
          return `tool_result(${block.is_error ? "error" : "ok"}): ${block.content.slice(0, 500)}`;
        });
        return `${message.role}: ${parts.join(" | ")}`;
      })
      .join("\n")
      .slice(0, 24000);

    try {
      const response = await this.deps.provider.complete({
        system:
          "You compact agent conversations. Reply ONLY with a JSON object: " +
          '{"goal":string,"filesTouched":string[],"errorsResolved":string[],"summary":string,"nextStep":string}',
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Goal: ${hint.goal}\nFiles already touched: ${hint.filesTouched.join(", ")}\n\nTranscript:\n${transcript}`,
              },
            ],
          },
        ],
        tools: [],
        model: this.deps.config.model,
        maxTokens: 1024,
      });
      this.deps.costTracker.add(response.usage);

      const text = response.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Checkpoint>;
        return {
          goal: parsed.goal ?? hint.goal,
          filesTouched: parsed.filesTouched ?? hint.filesTouched,
          errorsResolved: parsed.errorsResolved ?? [],
          summary: parsed.summary ?? "",
          nextStep: parsed.nextStep ?? "Continue.",
        };
      }
    } catch (error) {
      this.deps.logger.debug(`LLM summarizer failed, using heuristic: ${(error as Error).message}`);
    }
    return ContextManager.heuristicCheckpoint(older, hint);
  }

  private buildSystemPrompt(mode: PermissionMode): string {
    const parts = [this.deps.systemPrompt];
    if (mode === "plan") {
      parts.push(
        "\n[PLAN MODE] Only read-only tools are available. Produce a concrete, ordered plan and stop. Do not attempt modifications.",
      );
    }
    if (mode === "pair") {
      parts.push(
        [
          "\n[PAIR MODE] You are collaborating with the user, not working alone.",
          "Before touching anything, spend one short turn asking the questions that actually change what you build:",
          "the goal and its success criteria, constraints, the files or systems in scope, and any preference the user has.",
          "Ask at most four focused questions, numbered, each answerable in a sentence. Do not use tools in that first turn.",
          "Then, in the same turn, restate the plan in one or two lines and wait for confirmation before the first mutation.",
          "After confirmation, work normally and explain each significant decision as you go.",
        ].join("\n"),
      );
    }
    return parts.join("\n");
  }

  private async executeTool(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.deps.registry.get(name);
    if (!tool) {
      return {
        ok: false,
        output: "",
        error: `Unknown tool "${name}". Available: ${this.deps.registry.names().join(", ")}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = tool.parse(input);
    } catch (error) {
      return { ok: false, output: "", error: `Invalid input for ${name}: ${(error as Error).message}` };
    }

    // Before hooks can veto the call or hand back different arguments. A
    // rewrite goes through `parse` again, so a hook cannot smuggle in input the
    // schema would have rejected.
    const hookDecision = await this.deps.hooks.toolBefore({ toolName: name, input: parsed });
    if (hookDecision.block) {
      return { ok: false, output: "", error: `Blocked by a before hook: ${hookDecision.reason ?? ""}` };
    }
    if (hookDecision.input !== undefined) {
      try {
        parsed = tool.parse(hookDecision.input);
      } catch (error) {
        return { ok: false, output: "", error: `A before hook rewrote ${name} input into something invalid: ${(error as Error).message}` };
      }
    }

    // A preview may reject the path (outside the workspace) or fail outright.
    // Either way the model should see the reason, not a crashed loop.
    let preview = "";
    if ("preview" in tool && typeof (tool as { preview?: unknown }).preview === "function") {
      try {
        preview = await (tool as { preview: (i: unknown, c: ToolContext) => Promise<string> }).preview(parsed, ctx);
      } catch (error) {
        return { ok: false, output: "", error: (error as Error).message };
      }
    }

    const decision = await this.deps.gate.authorize({ tool, input: parsed, preview });
    if (decision === "deny") {
      return { ok: false, output: "", error: "User denied this tool call." };
    }

    let result: ToolResult;
    try {
      result = await tool.run(parsed, ctx);
    } catch (error) {
      result = { ok: false, output: "", error: `Tool ${name} threw: ${(error as Error).message}` };
    }

    const after = await this.deps.hooks.toolAfter({
      toolName: name,
      input: parsed,
      result: { ok: result.ok, output: result.output.slice(0, 2000) },
    });
    if (after.output !== undefined) result = { ...result, output: after.output };

    return result;
  }

  async run(
    history: Message[],
    goal: string,
    options: RunOptions = {},
  ): Promise<AgentRunResult> {
    const maxSteps = this.deps.config.maxSteps;
    const abortController = new AbortController();
    const external = options.signal;
    if (external) {
      if (external.aborted) abortController.abort();
      else external.addEventListener("abort", () => abortController.abort(), { once: true });
    }
    const ctx: ToolContext = { ...this.deps.toolContext, signal: abortController.signal };
    const filesTouched = new Set<string>();

    for (let step = 0; step < maxSteps; step++) {
      if (ctx.signal.aborted) {
        return { steps: step, finalText: "", stoppedReason: "aborted" };
      }
      options.onStep?.(step + 1, maxSteps);

      // Steering lands before the next model call, so the model sees the new
      // instruction with the observations from the step that just finished.
      const steering = this.deps.takeSteering?.() ?? [];
      for (const text of steering) {
        const message: Message = { role: "user", content: [{ type: "text", text }] };
        history.push(message);
        this.deps.session.recordMessage(message);
      }
      if (steering.length > 0) options.onSteer?.(steering);

      // Cheap pass first: masking old observations keeps every tool pair intact
      // and usually drops enough tokens to push a full compaction far away.
      if (this.deps.contextManager.shouldMask(history)) {
        const masked = this.deps.contextManager.maskObservations(history);
        if (this.deps.contextManager.lastMaskedCount > 0) {
          history.splice(0, history.length, ...masked);
          this.deps.logger.info(
            `Masked ${this.deps.contextManager.lastMaskedCount} old observation(s) to reclaim context.`,
          );
        }
      }

      if (this.deps.contextManager.shouldCompact(history)) {
        this.deps.logger.info("Context window 75%+ full: compacting conversation.");
        if (this.deps.compaction !== undefined) {
          // The pipeline also runs the cheap layers, so a full summary is only
          // paid for when masking and projection were not enough.
          const { messages: compactedMessages, report } = await this.deps.compaction.autoCompact(history, goal, filesTouched);
          if (report.layers.some((layer) => layer.applied && layer.layer === 5)) {
            history.splice(0, history.length, ...compactedMessages);
            this.deps.logger.info(
              `Compacted ${report.tokensBefore} -> ${report.tokensAfter} tokens; live state re-anchored.`,
            );
          }
        } else {
          const compaction = await this.deps.contextManager.compact(
            history,
            goal,
            filesTouched,
            (older, hint) => this.summarize(older, hint),
          );
          if (compaction.compacted && compaction.checkpoint) {
            history.splice(0, history.length, ...compaction.messages);
            this.deps.session.recordCheckpoint(compaction.checkpoint);
          }
        }
      }

      const response = await this.deps.provider.complete({
        system: this.buildSystemPrompt(this.deps.config.mode),
        messages: history,
        tools: this.advertised().schemas() as ToolSchema[],
        model: this.deps.config.model,
        maxTokens: this.deps.config.maxTokens,
        ...(this.deps.config.effort !== undefined ? { effort: this.deps.config.effort } : {}),
        signal: ctx.signal,
        ...(options.onText && !options.silent ? { onText: options.onText } : {}),
      });
      this.deps.costTracker.add(response.usage);

      const assistantMessage: Message = { role: "assistant", content: response.content };
      history.push(assistantMessage);
      this.deps.session.recordMessage(assistantMessage);

      const toolUses = response.content.filter(
        (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
      );
      const text = response.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (toolUses.length === 0) {
        return { steps: step + 1, finalText: text, stoppedReason: "completed" };
      }

      // Consecutive read-only calls are independent, so they run together;
      // a call with a side effect breaks the batch and runs on its own.
      const results: ContentBlock[] = [];
      for (let index = 0; index < toolUses.length; ) {
        const first = toolUses[index];
        if (first === undefined) break;
        const batch = [first];
        if (this.parallelSafe(first.name)) {
          while (index + batch.length < toolUses.length) {
            const next = toolUses[index + batch.length];
            if (next === undefined || !this.parallelSafe(next.name)) break;
            batch.push(next);
          }
        }
        index += batch.length;

        const blocks = await mapWithConcurrency(batch, MAX_PARALLEL_TOOLS, (toolUse) =>
          this.runToolUse(toolUse, ctx, options, filesTouched),
        );
        results.push(...blocks);
      }

      const userMessage: Message = { role: "user", content: results };
      history.push(userMessage);
      this.deps.session.recordMessage(userMessage);
    }

    return {
      steps: maxSteps,
      finalText: `Reached the ${maxSteps}-step limit without finishing. Raise it with --max-steps or narrow the goal.`,
      stoppedReason: "max_steps",
    };
  }
}
