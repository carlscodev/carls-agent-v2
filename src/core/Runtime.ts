import { platform, release } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Message, Provider } from "../types/llm.js";
import type { ToolContext } from "../types/tools.js";
import type { AgentRunResult } from "../types/agent.js";
import type { Effort, PermissionMode, ResolvedConfig } from "../config/Config.js";
import { specFor } from "../config/Config.js";
import { Logger } from "../utils/Logger.js";
import { createProvider } from "../providers/ProviderBase.js";
import { ollamaShow } from "../providers/OllamaProvider.js";
import { localModelContext } from "../providers/discovery.js";
import { PermissionGate } from "../security/PermissionGate.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { FileRead } from "../tools/FileRead.js";
import { FileWrite } from "../tools/FileWrite.js";
import { FileEdit } from "../tools/FileEdit.js";
import { GlobFiles } from "../tools/GlobFiles.js";
import { GrepSearch } from "../tools/GrepSearch.js";
import { BashExecution } from "../tools/BashExecution.js";
import { DelegateTask } from "../tools/DelegateTask.js";
import { TodoWrite } from "../tools/TodoWrite.js";
import { UseSkill } from "../tools/UseSkill.js";
import { SaveSkill } from "../tools/SaveSkill.js";
import {
  ApplyPatch,
  Base64File,
  FileAppend,
  FileCopy,
  FileDelete,
  FileDiff,
  FileMove,
  HashFile,
  ListDir,
  MakeDir,
  MultiRead,
  PathInfo,
  TreeView,
  WriteMany,
} from "../tools/FileOps.js";
import {
  ClipboardRead,
  ClipboardWrite,
  ComputerUse,
  EnvGet,
  EnvSet,
  HttpDownload,
  NetworkRequest,
  ProcessList,
  SleepWait,
  SystemInfo,
} from "../tools/SystemOps.js";
import { WebFetch, WebSearch } from "../tools/WebOps.js";
import { LspTool } from "../tools/Lsp.js";
import {
  BrowserClick,
  BrowserClose,
  BrowserEval,
  BrowserOpen,
  BrowserScreenshot,
  BrowserText,
  BrowserType,
} from "../tools/BrowserOps.js";
import {
  GitBlame,
  GitBranch,
  GitCommit,
  GitDiff,
  GitLog,
  GitStatus,
  SecretScan,
} from "../tools/GitOps.js";
import { SkillRegistry } from "../skills/SkillRegistry.js";
import { SessionStore } from "./SessionStore.js";
import { BackupStore } from "./Backups.js";
import { CostTracker } from "./CostTracker.js";
import { Hooks } from "./Hooks.js";
import { MemoryLoader } from "./MemoryLoader.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { ContextManager, contextReport } from "./ContextManager.js";
import { SubAgent } from "./SubAgent.js";
import { AgentLoop, type RunOptions } from "./AgentLoop.js";
import { McpClient } from "../mcp/McpClient.js";

export interface RuntimeDeps {
  config: ResolvedConfig;
  logger: Logger;
  session: SessionStore;
}

export class Runtime {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly session: SessionStore;
  readonly cost: CostTracker;
  readonly hooks: Hooks;
  readonly contextManager: ContextManager;
  readonly registry: ToolRegistry;
  /** The subset of `registry` whose schemas are sent to the model. */
  private advertised: ToolRegistry;
  readonly gate: PermissionGate;
  readonly loop: AgentLoop;
  readonly subAgent: SubAgent;
  readonly backups: BackupStore;
  readonly skills: SkillRegistry;
  readonly history: Message[];
  /** Mutable so /setup can swap the client without a restart. */
  private provider: Provider;
  private readonly mcpClients: McpClient[] = [];
  private readonly mcpSummary: { name: string; transport: string; tools: number; version?: string }[] = [];

  constructor(deps: RuntimeDeps, history: Message[] = []) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.session = deps.session;
    this.history = history;

    this.cost = new CostTracker(this.config.model);
    this.backups = new BackupStore(this.session.id);
    this.skills = new SkillRegistry(this.config.cwd);
    this.hooks = new Hooks(this.config.hooks, this.logger, this.config.cwd);
    this.contextManager = new ContextManager({
      contextWindow: this.config.contextWindow,
      compactThreshold: this.config.compactThreshold,
      truncateLimit: this.config.truncateLimit,
    });
    this.gate = new PermissionGate(this.config, this.logger);

    this.registry = new ToolRegistry();
    for (const tool of [
      new FileRead(),
      new FileWrite(),
      new FileEdit(),
      new GlobFiles(),
      new GrepSearch(),
      new BashExecution(),
      new DelegateTask(),
      new TodoWrite(),
      new UseSkill(),
      new SaveSkill(),
      new MultiRead(),
      new FileAppend(),
      new FileDelete(),
      new FileMove(),
      new FileCopy(),
      new MakeDir(),
      new TreeView(),
      new FileDiff(),
      new ApplyPatch(),
      new HashFile(),
      new ListDir(),
      new WriteMany(),
      new PathInfo(),
      new Base64File(),
      new ProcessList(),
      new SystemInfo(),
      new NetworkRequest(),
      new HttpDownload(),
      new WebFetch(),
      new WebSearch(),
      new LspTool(),
      new EnvGet(),
      new EnvSet(),
      new SleepWait(),
      new ClipboardRead(),
      new ClipboardWrite(),
      new ComputerUse(),
      new BrowserOpen(),
      new BrowserClick(),
      new BrowserType(),
      new BrowserScreenshot(),
      new BrowserEval(),
      new BrowserText(),
      new BrowserClose(),
      new GitStatus(),
      new GitDiff(),
      new GitLog(),
      new GitBlame(),
      new GitBranch(),
      new GitCommit(),
      new SecretScan(),
    ]) {
      this.registry.register(tool);
    }

    // Advertise fewer tools on a local backend: the full set is ~3.2k tokens of
    // schema, which crowds out the actual task on a small model.
    this.advertised = this.selectAdvertisedTools();

    this.provider = this.buildProvider();

    this.subAgent = new SubAgent({
      registry: this.registry,
      createLoop: (registry, maxSteps) => {
        const subConfig: ResolvedConfig = {
          ...this.config,
          maxSteps,
          mode: "auto",
        };
        return new AgentLoop({
          provider: this.provider,
          registry,
          gate: new PermissionGate(subConfig, this.logger, async () => "y"),
          contextManager: this.contextManager,
          session: this.session,
          costTracker: this.cost,
          hooks: this.hooks,
          config: subConfig,
          logger: this.logger,
          systemPrompt: buildSystemPrompt(subConfig),
          toolContext: this.subAgentToolContext(),
        });
      },
    });

    this.loop = new AgentLoop({
      provider: this.provider,
      registry: this.registry,
      advertise: this.advertised,
      gate: this.gate,
      contextManager: this.contextManager,
      session: this.session,
      costTracker: this.cost,
      hooks: this.hooks,
      config: this.config,
      logger: this.logger,
      systemPrompt: buildSystemPrompt(this.config),
      toolContext: this.baseToolContext(),
    });
  }

  private baseToolContext(): Omit<ToolContext, "signal"> {
    return {
      cwd: this.config.cwd,
      config: this.config,
      session: this.session,
      logger: this.logger,
      backups: this.backups,
      skills: this.skills,
      spawnSubAgent: (goal: string) => this.subAgent.run(goal),
    };
  }

  /** Sub-agents get no `spawnSubAgent`, which prevents unbounded nesting. */
  private subAgentToolContext(): Omit<ToolContext, "signal"> {
    return {
      cwd: this.config.cwd,
      config: this.config,
      session: this.session,
      logger: this.logger,
    };
  }

  private buildProvider(): Provider {
    return createProvider(this.config, (attempt, delayMs, error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `rate-limited/unavailable (attempt ${attempt}); retrying in ${(delayMs / 1000).toFixed(1)}s · ${message.slice(0, 160)}`,
      );
    });
  }

  /**
   * Picks the tool set sent to the model. An explicit `tools` list always wins.
   * Otherwise a local backend gets the core set, because shipping ~3.2k tokens
   * of schema to a model with a 4k window leaves no room for the task.
   */
  private selectAdvertisedTools(): ToolRegistry {
    const explicit = this.config.tools;
    if (explicit !== undefined && explicit.length > 0) {
      const restricted = this.registry.restrictedTo(explicit);
      if (restricted.names().length === 0) {
        this.logger.warn(`No known tool matches "${explicit.join(", ")}"; advertising all tools.`);
        return this.registry;
      }
      return restricted;
    }
    const spec = specFor(this.config.provider);
    if (spec?.local === true) return this.registry.coreToolset();
    return this.registry;
  }

  /**
   * Rebuilds the model client from the current config. Called after /setup so
   * a new provider, key or base URL takes effect without restarting.
   */
  rebuildProvider(): void {
    this.provider = this.buildProvider();
    this.loop.setProvider(this.provider);
  }

  async connectMcpServers(): Promise<void> {
    const entries = Object.entries(this.config.mcpServers);
    for (const [name, serverConfig] of entries) {
      let client: McpClient | undefined;
      try {
        client = new McpClient(name, serverConfig, this.logger, this.config.cwd);
        await client.initialize();
        const tools = await client.listTools();
        let registered = 0;
        for (const tool of client.asTools()) {
          // Two servers exposing the same tool name must not take the whole
          // startup down: keep the first and say which one was skipped.
          if (this.registry.has(tool.name)) {
            this.logger.warn(`MCP "${name}": tool ${tool.name} already exists; skipped.`);
            continue;
          }
          this.registry.register(tool);
          registered++;
        }
        const info = client.serverInfo();
        this.mcpSummary.push({
          name,
          transport: client.transportKind,
          tools: registered,
          ...(info?.version !== undefined ? { version: info.version } : {}),
        });
        this.logger.info(`MCP "${name}" (${client.transportKind}): registered ${registered} tool(s).`);
        this.mcpClients.push(client);
      } catch (error) {
        this.logger.warn(`MCP "${name}" unavailable: ${(error as Error).message}`);
        client?.close();
      }
    }
  }

  /** Connected MCP servers, for `/mcp` and `/doctor`. */
  mcpServers(): { name: string; transport: string; tools: number; version?: string }[] {
    return this.mcpSummary;
  }

  /** The registry whose schemas are advertised to the model (may be a subset). */
  advertisedTools(): ToolRegistry {
    return this.advertised;
  }

  async start(): Promise<void> {
    await this.syncContextWindow();
    await this.hooks.sessionStart({ cwd: this.config.cwd, sessionId: this.session.id });
  }

  /**
   * Aligns the compaction window with what the endpoint reports for the selected
   * model. Best effort: a cloud provider or an unreachable endpoint simply keeps
   * the configured value, and an explicit contextWindow in the config is treated
   * as the user's decision and left alone.
   */
  private async syncContextWindow(): Promise<void> {
    if (this.config.contextWindowPinned === true) return;
    const spec = specFor(this.config.provider);
    if (spec?.local !== true) return;
    let detected: number | undefined;
    if (spec.protocol === "ollama") {
      try {
        const info = await ollamaShow(this.config.baseUrl ?? spec.baseUrl, this.config.model);
        detected = info.contextLength;
      } catch {
        return;
      }
    } else {
      detected = await localModelContext(this.config.baseUrl ?? spec.baseUrl, this.config.model);
    }
    if (detected === undefined || detected === this.contextManager.window()) return;
    // Update both readers so the status line and the compaction trigger agree;
    // leaving config stale made /context report a different window than the one
    // compaction actually used.
    this.contextManager.setContextWindow(detected);
    this.config.contextWindow = detected;
    this.logger.info(
      `context window set to ${detected.toLocaleString()} from the ${spec.label} endpoint.`,
    );
  }

  async runTurn(goal: string, options: RunOptions = {}): Promise<AgentRunResult> {
    const userMessage: Message = { role: "user", content: [{ type: "text", text: goal }] };
    this.history.push(userMessage);
    this.session.recordMessage(userMessage);
    return this.loop.run(this.history, goal, options);
  }

  contextReport(): string {
    return contextReport(this.history, this.config.contextWindow);
  }

  resetHistory(): void {
    this.history.length = 0;
  }

  /** Replaces the whole history (used by /resume). */
  replaceHistory(messages: Message[]): void {
    this.history.splice(0, this.history.length, ...messages);
  }

  /** Appends a user note to the history without calling the model. */
  addNote(text: string): void {
    const message: Message = { role: "user", content: [{ type: "text", text: `[note] ${text}` }] };
    this.history.push(message);
    this.session.recordMessage(message);
  }

  /** Current agent plan, as recorded by the todo_write tool. */
  todos(): { title: string; status: string }[] {
    return TodoWrite.current;
  }

  clearTodos(): void {
    TodoWrite.current = [];
  }

  setModel(model: string): void {
    this.config.model = model;
    this.cost.setModel(model);
  }

  setEffort(effort: Effort | undefined): void {
    if (effort === undefined) delete this.config.effort;
    else this.config.effort = effort;
  }

  setMode(mode: PermissionMode): void {
    this.config.mode = mode;
  }

  /** Applies a preset's tool and command rules; the gate reads the same object. */
  setPermissions(permissions: ResolvedConfig["permissions"]): void {
    this.config.permissions = permissions;
  }

  /** Narrows or widens the advertised tools; execution stays untouched. */
  setTools(tools: string[] | undefined): void {
    if (tools === undefined || tools.length === 0) delete this.config.tools;
    else this.config.tools = tools;
    this.advertised = this.selectAdvertisedTools();
    this.loop.setAdvertised(this.advertised);
  }

  /** Switches the active agent preset, rebuilding the system prompt. */
  setAgent(name: string | undefined, prompt: string | undefined): void {
    if (name === undefined || prompt === undefined) {
      delete this.config.agentName;
      delete this.config.agentPrompt;
    } else {
      this.config.agentName = name;
      this.config.agentPrompt = prompt;
    }
    this.loop.setSystemPrompt(buildSystemPrompt(this.config));
  }

  /** Manual compaction; returns true when it actually compacted. */
  async compactNow(): Promise<boolean> {
    const compaction = await this.contextManager.compact(
      this.history,
      "(manual compact)",
      new Set(),
      async (older, hint) => ContextManager.heuristicCheckpoint(older, hint),
    );
    if (!compaction.compacted) return false;
    this.replaceHistory(compaction.messages);
    return true;
  }

  async close(): Promise<void> {
    await this.hooks.sessionEnd({ sessionId: this.session.id });
    for (const client of this.mcpClients) client.close();
  }
}

export function buildSystemPrompt(config: ResolvedConfig): string {
  const sections: string[] = [];
  sections.push(
    [
      "You are carls-code, an autonomous software engineering agent working in a terminal.",
      "You operate in a strict gather-act-verify loop:",
      "1. GATHER: explore with read_file, glob_files, grep_search before changing anything.",
      "2. ACT: apply minimal changes with edit_file or write_file.",
      "3. VERIFY: run the project's tests, linter or compiler with bash and fix failures until they pass.",
      "Never claim something works without running it. Prefer small, reviewable edits.",
      "Delegate broad exploration to delegate_task to keep your context small.",
      "Independent read-only calls run in parallel, so ask for every read_file, grep_search, glob_files",
      "or delegate_task you already know you need in the SAME turn instead of one after another.",
      "Use the specialised tools instead of bash when one exists: multi_read and write_many batch file I/O,",
      "apply_patch applies a unified diff, tree_view and list_dir map a project, git_* cover version control,",
      "web_search and web_fetch read the web (fetch returns text, not markup), network_request and http_download",
      "handle raw HTTP, computer_use and browser_* drive a desktop or a page,",
      "and secret_scan checks for leaked credentials before you commit.",
      "Stop and summarise once the goal is met or you are blocked.",
    ].join("\n"),
  );

  sections.push(`Environment: ${platform()} ${release()} · node ${process.version} · cwd ${config.cwd}`);

  const git = gitSnapshot(config.cwd);
  if (git !== undefined) sections.push(`Git:\n${git}`);

  const memory = MemoryLoader.load(config.cwd);
  if (memory) sections.push(`Project instructions (${memory.file}):\n${memory.content}`);

  const skills = SkillLoader.discover(config.cwd);
  if (skills.length > 0) {
    // The index is a menu, not the catalog: past a few dozen entries it costs
    // more context than the task. The rest stay reachable by name.
    const indexLimit = 40;
    const listed = skills.slice(0, indexLimit);
    const index = listed
      .map((skill) => {
        const when = skill.whenToUse !== undefined ? ` — ${skill.whenToUse}` : "";
        return `- ${skill.name}: ${skill.description}${when}`;
      })
      .join("\n")
      .concat(skills.length > indexLimit ? `\n… ${skills.length - indexLimit} more; ask for one by name.` : "");
    sections.push(
      [
        "Skills (reusable procedures). Read one with use_skill before acting when it matches the task,",
        "and add new ones with save_skill after discovering a non-obvious workflow:",
        index,
      ].join("\n"),
    );
  }

  // An agent preset comes last: it is the most specific instruction in the
  // prompt, and it should be the freshest thing the model read.
  if (config.agentPrompt !== undefined && config.agentPrompt.trim().length > 0) {
    const label = config.agentName !== undefined ? `Agent: ${config.agentName}` : "Active agent";
    sections.push(`${label}\n${config.agentPrompt.trim()}`);
  }

  return sections.join("\n\n");
}

function gitSnapshot(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--short"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return `branch ${branch}${status.length > 0 ? `\n${status.slice(0, 4000)}` : " · clean"}`;
  } catch {
    return undefined;
  }
}

export function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "../../package.json"), join(here, "../../../package.json")]) {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
        if (parsed.version) return parsed.version;
      }
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}
