import type { ContentBlock, LLMResponse, Message, Provider, ToolSchema } from "../types/llm.js";
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
import { StreamingToolExecutor, type PrefetchedToolResult } from "./StreamingToolExecutor.js";
import type { EventBus } from "./EventBus.js";
import { fileStateCache } from "./FileStateCache.js";
import type { SkillRegistry } from "../skills/SkillRegistry.js";
import { discoverSkillsForGoal } from "../skills/SkillDiscovery.js";

/**
 * How many independent read-only calls one assistant turn may run at once.
 * Exploration is dominated by wall-clock latency, not CPU: a turn that asks for
 * grep + five reads + two sub-agents used to pay for every one of them in
 * series. Six keeps a local endpoint and the permission gate comfortable.
 */
const MAX_PARALLEL_TOOLS = 6;

/** Tools that actually put something on disk, for the Execution-First guard. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "write_many",
  "file_append",
  "file_delete",
  "file_move",
  "file_copy",
  "make_dir",
  "lsp_edit",
]);

const LAZY_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  "html",
  "tsx",
  "jsx",
  "ts",
  "js",
  "css",
  "vue",
  "svelte",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
]);

/** True when the operator asked for something to be built, not merely explained. */
export function isCreationRequest(goal: string): boolean {
  const normalized = goal
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(crea\w*|constru\w*|haz\w*|hacer|build|create|make|genera\w*|desarrolla\w*)\b/.test(normalized);
}

/** Detects a long fenced source block that should have been written to disk. */
export function lazyCodeDump(text: string): { language: string; lines: number } | undefined {
  const fence = /```([A-Za-z0-9+#-]*)\r?\n([\s\S]*?)```/g;
  for (;;) {
    const match = fence.exec(text);
    if (match === null) return undefined;
    const language = (match[1] ?? "").toLowerCase();
    if (!LAZY_CODE_LANGUAGES.has(language)) continue;
    const body = match[2] ?? "";
    const lines = body.split("\n");
    const count = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (count > 25) return { language, lines: count };
  }
}

/** The corrective observation injected when the model tries to chat code at us. */
export const EXECUTION_FIRST_CORRECTION =
  "[SISTEMA]: Violación de protocolo Execution-First. No pegues el código en el chat. Usa write_file / edit_file ahora mismo para escribir estos archivos directamente en el disco y verifica su funcionamiento.";

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
  /** Optional push bus; views subscribe instead of polling the loop. */
  events?: EventBus;
  /** Skill catalog used for the per-turn auto-discovery block. */
  skillRegistry?: SkillRegistry;
}

export interface RunOptions {
  /** Suppress streaming/UI output (used by sub-agents). */
  silent?: boolean;
  /** Called for every assistant text delta. */
  onText?: (chunk: string) => void;
  /** Called for every reasoning/thinking delta, kept separate from the answer. */
  onReasoning?: (chunk: string) => void;
  /** Called after each tool finishes, for UI rendering. */
  onToolResult?: (name: string, result: ToolResult, durationMs: number) => void;
  /** Called right before a tool starts, so the UI can name what is running. */
  onToolStart?: (name: string, input: unknown) => void;
  /** Called when steering messages were folded into the conversation. */
  onSteer?: (messages: string[]) => void;
  /** Called at the start of every model step, for progress UI. */
  onStep?: (step: number, maxSteps: number) => void;
  /** External abort, e.g. Ctrl+C in the REPL. */
  signal?: AbortSignal;
  /**
   * Suppress the raw tool call/result lines on stderr. The full-screen REPL
   * renders those as viewport cards; streaming callbacks stay enabled.
   */
  quietStderr?: boolean;
}

export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  /**
   * Executor for the step in flight. The step paths cancel it themselves, but
   * an abrupt throw or an external abort must not leave a prefetched read
   * running against a turn that is already over.
   */
  private activeTools: StreamingToolExecutor | undefined;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
  }

  /** Cancels any prefetched tool still running for this loop. */
  abortActiveTools(): void {
    this.activeTools?.abort();
    this.activeTools = undefined;
  }

  /** Cancels one step's prefetch cohort and clears the safety-net pointer. */
  private finishTools(executor: StreamingToolExecutor): void {
    executor.abort();
    if (this.activeTools === executor) this.activeTools = undefined;
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
    // An exclusive tool (the interactive question box) owns the keyboard, so it
    // must never share a batch with a read that could steal focus.
    return tool !== undefined && tool.readOnly && tool.exclusive !== true;
  }

  /**
   * Runs one tool call, renders it, and returns the observation block to feed
   * back to the model. Never throws, so a batch of parallel calls cannot reject
   * half-way and drop the results of the calls that already finished.
   *
   * A `prefetched` result came from `StreamingToolExecutor`: the call already
   * ran while the model was still streaming, so this only renders its result and
   * keeps the transcript in `tool_use` order.
   */
  private async runToolUse(
    toolUse: Extract<ContentBlock, { type: "tool_use" }>,
    ctx: ToolContext,
    options: RunOptions,
    filesTouched: Set<string>,
    prefetched?: PrefetchedToolResult,
  ): Promise<ContentBlock> {
    if (prefetched === undefined) {
      if (!options.silent && options.quietStderr !== true) {
        process.stderr.write(`\n${toolCallLine(toolUse.name, toolUse.input)}\n`);
      }
      options.onToolStart?.(toolUse.name, toolUse.input);
      this.deps.events?.emit("tool.start", {
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        at: Date.now(),
      });
    }

    let result: ToolResult;
    let durationMs: number;
    if (prefetched !== undefined) {
      result = prefetched.result;
      durationMs = prefetched.durationMs;
    } else {
      const startedAt = Date.now();
      try {
        result = await this.executeTool(toolUse.name, toolUse.input, ctx);
      } catch (error) {
        result = { ok: false, output: "", error: `Tool ${toolUse.name} failed: ${(error as Error).message}` };
      }
      durationMs = Date.now() - startedAt;
    }

    if (!options.silent && options.quietStderr !== true) {
      process.stderr.write(`${toolResultLine(toolUse.name, result, durationMs)}\n`);
    }
    options.onToolResult?.(toolUse.name, result, durationMs);
    // The prefetcher already published `tool.done` when the run finished; a call
    // executed inline publishes it here so every path looks the same to a view.
    if (prefetched === undefined) {
      this.deps.events?.emit("tool.done", {
        id: toolUse.id,
        name: toolUse.name,
        ok: result.ok,
        durationMs,
        at: Date.now(),
      });
    }

    if (result.ok) {
      const path = result.metadata?.path;
      if (typeof path === "string") filesTouched.add(path);
    }
    this.invalidateFileState(toolUse.name, result, ctx);

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
   * Drops cached parse state for whatever a write tool touched. Done centrally
   * so a new write tool cannot forget it and leave `repo_map` serving symbols
   * from before the edit.
   */
  private invalidateFileState(toolName: string, result: ToolResult, ctx: ToolContext): void {
    if (!result.ok) return;
    const tool = this.deps.registry.get(toolName);
    if (tool === undefined || tool.readOnly) return;
    const paths = result.metadata?.paths;
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === "string") fileStateCache.invalidate(path);
      }
      return;
    }
    const path = result.metadata?.path;
    if (typeof path === "string") {
      fileStateCache.invalidate(path);
      return;
    }
    // A multi-file write with no path metadata may have touched any file under
    // the workspace. Dropping the subtree costs one rebuild, not a stale index.
    fileStateCache.invalidateUnder(ctx.cwd);
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
    // Compute the turn prompt once: the skill catalog is static for the run, and
    // rebuilding it on every step would only duplicate tokens.
    const discovery =
      this.deps.skillRegistry !== undefined
        ? discoverSkillsForGoal(this.deps.skillRegistry, goal)
        : { relevant: [], block: "" };
    const baseSystem = this.buildSystemPrompt(this.deps.config.mode);
    const turnSystem = discovery.block.length > 0 ? `${baseSystem}\n\n${discovery.block}` : baseSystem;
    const creationRequest = isCreationRequest(goal);
    let madeChanges = false;
    let lazyCorrections = 0;

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
          for (const layer of report.layers) {
            this.deps.events?.emit("compaction.layer", {
              layer: layer.layer,
              applied: layer.applied,
              tokensBefore: report.tokensBefore,
              tokensAfter: report.tokensAfter,
              at: Date.now(),
            });
          }
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

      // Read-only calls are prefetched as soon as their arguments close in the
      // stream. The executor is scoped to this step: it must not outlive the
      // assistant message whose tool_use blocks it is executing.
      const streamTools = new StreamingToolExecutor({
        execute: (call, signal) => this.executeTool(call.name, call.input, { ...ctx, signal }),
        signal: ctx.signal,
        maxParallel: MAX_PARALLEL_TOOLS,
        onStart: (call) => {
          if (!options.silent && options.quietStderr !== true) {
            process.stderr.write(`\n${toolCallLine(call.name, call.input)}\n`);
          }
          options.onToolStart?.(call.name, call.input);
          this.deps.events?.emit("tool.start", {
            id: call.id,
            name: call.name,
            input: call.input,
            at: Date.now(),
          });
        },
        onDone: (call, outcome) => {
          this.deps.events?.emit("tool.done", {
            id: call.id,
            name: call.name,
            ok: outcome.result.ok,
            durationMs: outcome.durationMs,
            at: Date.now(),
          });
        },
      });
      this.activeTools = streamTools;

      const forwardText = options.onText;
      const forwardReasoning = options.onReasoning;
      const onText =
        forwardText !== undefined && options.silent !== true
          ? (chunk: string): void => {
              this.deps.events?.emit("stream.delta", { kind: "text", text: chunk, at: Date.now() });
              forwardText(chunk);
            }
          : undefined;
      const onReasoning =
        forwardReasoning !== undefined && options.silent !== true
          ? (chunk: string): void => {
              this.deps.events?.emit("stream.delta", { kind: "reasoning", text: chunk, at: Date.now() });
              forwardReasoning(chunk);
            }
          : undefined;

      let response: LLMResponse;
      try {
        response = await this.deps.provider.complete({
          system: turnSystem,
          messages: history,
          tools: this.advertised().schemas() as ToolSchema[],
          model: this.deps.config.model,
          maxTokens: this.deps.config.maxTokens,
          ...(this.deps.config.effort !== undefined ? { effort: this.deps.config.effort } : {}),
          signal: ctx.signal,
          ...(onText !== undefined ? { onText } : {}),
          ...(onReasoning !== undefined ? { onReasoning } : {}),
          onToolCall: (call) => {
            streamTools.submit({ id: call.id, name: call.name, input: call.input });
          },
        });
      } catch (error) {
        this.finishTools(streamTools);
        throw error;
      }
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
        // Anti-Lazy guard: a creation request answered with a long fenced code
        // block and no write is a protocol violation, not a finished task. Nudge
        // the model once, then let the normal loop continue so it can write.
        if (
          creationRequest &&
          !madeChanges &&
          this.deps.config.mode !== "plan" &&
          lazyCorrections < 1 &&
          lazyCodeDump(text) !== undefined
        ) {
          lazyCorrections += 1;
          const correction: Message = {
            role: "user",
            content: [{ type: "text", text: EXECUTION_FIRST_CORRECTION }],
          };
          history.push(correction);
          this.deps.session.recordMessage(correction);
          this.finishTools(streamTools);
          continue;
        }
        // A provider that emitted a tool call and then dropped it must not leave
        // a prefetched read running after the turn is already over.
        this.finishTools(streamTools);
        return { steps: step + 1, finalText: text, stoppedReason: "completed" };
      }

      // Remember that this turn actually produced files; the guard must not
      // nag a model that already did the work in an earlier step.
      for (const toolUse of toolUses) {
        if (WRITE_TOOLS.has(toolUse.name)) madeChanges = true;
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

        const blocks = await mapWithConcurrency(batch, MAX_PARALLEL_TOOLS, (toolUse) => {
          const call = { id: toolUse.id, name: toolUse.name, input: toolUse.input };
          if (!streamTools.has(toolUse.id)) {
            return this.runToolUse(toolUse, ctx, options, filesTouched);
          }
          // The call is already running; wait for it, then render its result in
          // the assistant's block order rather than the completion order.
          return streamTools
            .take(call)
            .then((prefetched) => this.runToolUse(toolUse, ctx, options, filesTouched, prefetched));
        });
        results.push(...blocks);
      }

      // Cancel any prefetched call the response did not include (a malformed or
      // truncated stream), so no read survives the step that requested it.
      this.finishTools(streamTools);

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
