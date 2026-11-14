import pc from "picocolors";
import { homedir } from "node:os";
import type { ResolvedConfig, ConfigOverrides } from "../config/Config.js";
import { loadConfig } from "../config/Config.js";
import { Logger } from "../utils/Logger.js";
import { SessionStore } from "../core/SessionStore.js";
import { Runtime } from "../core/Runtime.js";
import { Spinner, activityFrame, bannerLines, modeTag, printAssistantHeader, printError, printInfo, printStatusBar, printTurnSummary, tabStripLine, turnSummaryLine } from "./TerminalUI.js";
import { toolLabel } from "./ToolView.js";
import { Chrome } from "./Chrome.js";
import { folds } from "./Folds.js";
import { Splash } from "./Splash.js";
import { closeBrowser } from "../tools/BrowserOps.js";
import { packageVersion } from "../core/Runtime.js";
import { runCommand, runShellPassthrough } from "./Commands.js";
import { LineReader } from "./Input.js";
import { Prompt } from "./Prompt.js";
import { MODE_CYCLE } from "../config/Config.js";
import { MarkdownRenderer } from "./Markdown.js";
import { theme } from "./Theme.js";
import { openCommandPalette } from "./CommandPalette.js";
import { expandMentions, listWorkspaceFiles } from "./Mentions.js";
import { PromptQueue, collectTypedLines, drainQueue, type TypedLinesHandle } from "./Queue.js";
import { selectList } from "./SelectList.js";
import { TabManager, shortTitle, type Tab } from "./Tabs.js";
import { PromptWizardBox, wizardBoxHeight } from "./PromptWizardBox.js";
import { autoResolveAskUser, type AskUserHandler, type AskUserPayload, type AskUserResult } from "../types/askUser.js";
import { FrameCoalescer } from "./FrameRenderer.js";
import {
  AnimationTicker,
  SPINNER_FRAMES,
  renderAgentFleet,
  renderPhaseTimeline,
  type AgentFleetEntry,
  type PhaseCell,
  type PhaseStatus,
  type PhaseTimelineState,
} from "./AnimationTicker.js";
import { SmoothStreamRenderer, streamCursor } from "./SmoothStream.js";
import { ToolBatch, isGroupable, toolDetail, toolSummary, renderToolCard, toolCardDetail } from "./ToolCards.js";
import { RateWindow, renderContextCell, renderRateCell, renderServerBadge } from "./StatusHud.js";
import { ToastManager, attachToastBus } from "./Toast.js";
import {
  headerBar,
  homeIndexHint,
  reasoningFooter,
  reasoningHeader,
  userBlock,
} from "./MessageBlocks.js";
import { formatDuration, terminalDimension, truncate } from "./Text.js";
import { samePath } from "../utils/platform.js";
import { restoreTerminal, writeSessionBanner } from "./SessionBanner.js";
import { countTurns, resumeHydrationLines } from "./ResumeHydration.js";

export interface SessionOptions {
  overrides: Partial<ResolvedConfig>;
  config: ResolvedConfig;
  sessionId?: string;
  resumeMessages?: import("../types/llm.js").Message[];
  /** Keep the legacy inline layout instead of the alternate-screen TUI. */
  noAltScreen?: boolean;
}

export async function runRepl(options: SessionOptions): Promise<number> {
  const logger = new Logger(options.config.logLevel);
  /** Assigned once the footer exists; process events piggyback on it. */
  let refreshStatus: () => void = () => {};

  /**
   * Builds one tab's runtime. The config is cloned so a model or mode change in
   * one tab cannot leak into another; the session store is per-tab because its
   * id is the log file name.
   */
  const makeTab = async (
    sessionId: string | undefined,
    resumeMessages: import("../types/llm.js").Message[],
    title: string,
  ): Promise<Tab<Runtime>> => {
    const session = new SessionStore(options.config.cwd, options.config.model, sessionId);
    const runtime = new Runtime(
      { config: structuredClone(options.config), logger, session },
      resumeMessages,
    );
    await runtime.connectMcpServers();
    await runtime.start();
    // The handler is a lazy closure: the wizard needs `chrome`, which exists
    // only after the first tab is built. By the time ask_user runs, it is set.
    runtime.setAskUserHandler((payload) => askUserHandler(payload));
    // A dev server can crash while the prompt is idle; repaint the SRV badge
    // as soon as the sentinel reports a state change.
    runtime.events.on("process.updated", () => refreshStatus());
    return { id: session.id, title, payload: runtime };
  };

  const tabs = new TabManager<Runtime>(
    await makeTab(options.sessionId, options.resumeMessages ?? [], "main"),
  );
  /**
   * The active tab's runtime, reassigned on every tab switch. Keeping it a
   * `let` rather than a getter leaves the rest of the loop untouched: each
   * closure below reads the current tab's conversation, not a stale one.
   */
  let runtime = tabs.current().payload;

  const banner = bannerLines({
    model: options.config.model,
    provider: options.config.provider,
    cwd: options.config.cwd,
    sessionId: tabs.current().id,
    mode: options.config.mode,
    contextWindow: options.config.contextWindow,
    ...(options.config.effort !== undefined ? { effort: options.config.effort } : {}),
  });

  await Splash.show({
    name: "carls-code",
    version: packageVersion(),
    model: `${options.config.provider}/${options.config.model}`,
    cwd: options.config.cwd,
  });

  const reader = new LineReader();
  const prompt = new Prompt();
  const interactive = Prompt.supports(process.stdin);
  const chrome = new Chrome(process.stderr);
  const useChrome = interactive && Chrome.supported(process.stderr);
  const fullscreen = useChrome && options.noAltScreen !== true;
  let headerCache = "";
  const refreshHeader = (): void => {
    if (!useChrome) return;
    const text = headerBar({
      version: packageVersion(),
      mode: runtime.config.mode,
      model: runtime.config.model,
      provider: runtime.config.provider,
      cwd: runtime.config.cwd,
      sessionId: tabs.current().id,
    });
    if (text === headerCache) return;
    headerCache = text;
    chrome.setHeader(text);
  };
  const initialHeader = headerBar({
    version: packageVersion(),
    mode: options.config.mode,
    model: options.config.model,
    provider: options.config.provider,
    cwd: options.config.cwd,
    sessionId: tabs.current().id,
  });
  if (useChrome) {
    headerCache = initialHeader;
    chrome.enable(banner, { fullscreen, header: initialHeader });
    chrome.setComposerMode(options.config.mode);
  } else {
    process.stderr.write(`${banner.join("\n")}\n\n`);
  }
  const spinner = new Spinner(interactive && !fullscreen);
  /** Messages typed while a turn was running, drained in order afterwards. */
  const queue = new PromptQueue();
  let busy = false;
  /** Keyboard widget selected by ask_user; defaults to the headless resolver. */
  let askUserHandler: AskUserHandler = async (payload) => autoResolveAskUser(payload);
  /** The composer that owns stdin during a turn, paused while the box is open. */
  let activeComposer: TypedLinesHandle | undefined;
  let interruptCount = 0;
  let lastGoal: string | undefined;
  let activeAbort: AbortController | undefined;
  /** Set when `Esc` aborted the turn, so the closing line can say so. */
  let composerStoppedByEscape = false;
  /** Full-screen continuous animation clock (zero timers while idle). */
  let ticker: AnimationTicker | undefined;
  /** Sidebar inspector state in the full-screen layout. */
  let inspectorOpen = false;
  /**
   * Live activity, shown in the footer while a turn runs. A silent model looks
   * identical to a hung process, so the footer carries what the agent is doing
   * right now, how long it has been doing it, and which step it is on.
   */
  let activity: { label: string; startedAt: number; step?: number; maxSteps?: number } | undefined;
  /** Rough live generation rate for the footer while text streams. */
  let streamTelemetry: { chars: number; startedAt: number } | undefined;
  /** Rolling token-rate samples feeding the footer sparkline. */
  const rateWindow = new RateWindow(24);
  /** The markdown sink of the turn in flight, so the ticker can drive its cursor. */
  let streamMarkdown: MarkdownRenderer | undefined;
  /** Frame counter for the breathing write cursor. */
  let cursorTick = 0;
  /**
   * Gather -> Act -> Verify state for the phase line above the composer. Lives
   * only for the duration of a turn; cleared in the finally block so an idle
   * session does not reserve the row.
   */
  let phase: PhaseTimelineState | undefined;
  /** Frame counter for the live sub-agent fleet row. */
  let agentsTick = 0;
  /** Sub-agents currently running, keyed by `role:goal`, painted as one live row. */
  const agentFleet = new Map<string, AgentFleetEntry>();
  /** Floating notifications in the top-right corner. */
  const toasts = new ToastManager({
    onChange: () => {
      if (fullscreen) paintToasts();
    },
  });
  /** Set when the operator asked to leave; the finally block prints the resume banner. */
  let shutdownRequested = false;

  const turnCount = (target: Runtime): number =>
    target.history.filter((message) => message.role === "user").length;

  /** Restores the terminal and prints where to continue. Idempotent. */
  const printExitBanner = (): void => {
    const tab = tabs.current();
    tab.payload.flushState();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    if (useChrome) chrome.disable();
    else restoreTerminal(process.stderr);
    writeSessionBanner(process.stderr, tab.id, turnCount(tab.payload));
  };

  const onSigint = (): void => {
    if (busy && activeAbort) {
      // Case A: abort the turn cleanly, keep the session and the plan, and let
      // the operator press Ctrl+C again to leave once the prompt returns.
      activeAbort.abort();
      runtime.flushState();
      process.stderr.write(
        `\n${pc.yellow("[Turno cancelado por el operador — Presiona Ctrl+C de nuevo para salir]")}\n`,
      );
      return;
    }
    // Case B: leave immediately and leave a copy-pasteable resume command.
    shutdownRequested = true;
    printExitBanner();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  /**
   * Ctrl+O toggles the newest expandable card in the full-screen transcript.
   * In the scrolling layout it keeps the legacy fold behaviour.
   */
  const expandLast = (): void => {
    if (fullscreen) {
      const result = chrome.toggleCard();
      if (result === undefined) {
        writeLine(theme().paint(theme().colors.text.faint, "  nothing to expand yet"));
      }
      return;
    }
    const fold = folds().last();
    const t = theme();
    if (fold === undefined) {
      writeLine(t.paint(t.colors.text.faint, "  nothing to expand yet"));
      return;
    }
    const expanded = folds().toggle(fold.id)?.expanded === true;
    const head = `${t.paint(t.colors.accent, expanded ? "⌃" : "⌄")} ${t.bold(`${fold.name} · ${fold.title}`)} ${t.paint(t.colors.text.faint, `(#${fold.id}, ${fold.body.split("\n").length} lines)`)}`;
    if (!expanded) {
      writeLine(`\n${head} ${t.paint(t.colors.text.faint, "collapsed")}`);
      return;
    }
    const body = fold.body
      .split("\n")
      .map((line) => `${t.paint(t.colors.border, "┃")} ${t.paint(t.colors.text.muted, line)}`)
      .join("\n");
    writeLine(`\n${head}\n${body}`);
  };

  /** Writes a block to the conversation region, chrome or plain. */
  const writeLine = (text: string): void => {
    if (useChrome) {
      // The cursor sits on the prompt row, outside the scroll region, so it must
      // be moved back inside first or the block lands on the composer.
      chrome.moveToRegionBottom();
      chrome.writeRegion(`${text}\n`);
    } else {
      process.stderr.write(`${text}\n`);
    }
  };

  const onResize = (): void => chrome.resize();
  if (useChrome) process.on("SIGWINCH", onResize);

  const cycleMode = (): string | undefined => {
    const current = runtime.config.mode;
    const index = MODE_CYCLE.indexOf(current);
    const next = MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "ask";
    runtime.setMode(next);
    if (useChrome) chrome.setComposerMode(next);
    // Repaint the footer here: the status line is only redrawn after a turn, so
    // without this the mode changes silently and the footer keeps showing the
    // old mode until the next prompt completes.
    showStatus();
    return next;
  };

  /** `❯` marks the input everywhere, so the transcript and the prompt agree. */
  const promptGlyph = (): string => `${theme().paint(theme().colors.accent, "❯")} `;

  /** Renders a submitted line: a rich card in fullscreen, the old echo inline. */
  const echoUser = (text: string): void => {
    if (fullscreen) {
      chrome.writeBlock(userBlock(text, runtime.config.mode));
    } else if (useChrome) {
      chrome.writeRegion(`${promptGlyph()}${text}\n`);
    } else {
      process.stderr.write(`${promptGlyph()}${text}\n`);
    }
  };

  /**
   * Replays the tail of a resumed or freshly loaded session as compact cards, so
   * the screen matches the history the model is holding instead of staying blank.
   */
  const hydrateHistory = (messages: import("../types/llm.js").Message[]): void => {
    if (messages.length === 0) return;
    const shown = 3;
    const hydration = resumeHydrationLines(messages, {
      turns: shown,
      width: terminalDimension(process.stderr.columns, 80),
    });
    for (const line of hydration) writeLine(line);
    const total = countTurns(messages);
    if (total > shown) {
      writeLine(theme().paint(theme().colors.text.faint, `  … y ${total - shown} turno(s) anteriores en el contexto.`));
    }
  };

  /**
   * File picker behind `@`. It lists what git tracks and lets the user filter by
   * typing, which is faster than any fuzzy scoring the user cannot see.
   */
  const pickMention = async (): Promise<string | undefined> => {
    const files = listWorkspaceFiles(runtime.config.cwd);
    if (files.length === 0) {
      printInfo("No files to mention in this workspace.");
      return undefined;
    }
    const t = theme();
    const choice = await selectList({
      title: `${t.paint(t.colors.accent, "Mention a file")} ${t.paint(t.colors.text.faint, `${files.length} files`)}`,
      items: files.map((path) => ({ id: path, label: path })),
    });
    return choice?.id;
  };

  const tokenCount = (tokens: number): string =>
    tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(Math.round(tokens));

  /** One dense line: agent, telemetry, context pressure, spend, location. */
  const statusLine = (): string => {
    const t = theme();
    const ratio = runtime.contextManager.usedRatio(runtime.history);
    const home = homedir();
    const cwd =
      home.length > 1 && runtime.config.cwd.startsWith(home)
        ? `~${runtime.config.cwd.slice(home.length).replace(/^[\\/]/, "").replace(/\\/g, "/")}`
        : runtime.config.cwd;
    const parts = [
      modeTag(runtime.config.mode),
      t.paint(t.colors.text.muted, `${runtime.config.provider}/${runtime.config.model}`),
    ];
    // The active preset changes the mode and the tool set, so the footer has to
    // say which one is in charge or the change is invisible.
    if (runtime.config.agentName !== undefined) {
      parts.push(t.paint(t.colors.accent, `@${runtime.config.agentName}`));
    }
    if (runtime.config.effort !== undefined) parts.push(t.paint(t.colors.accent, runtime.config.effort));

    // Plan telemetry: the current node is the one a human would ask about.
    const dag = runtime.dag.snapshot();
    if (dag.nodes.length > 0) {
      const active =
        dag.nodes.find((node) => node.status === "running" || node.status === "verifying") ?? runtime.dag.next();
      const state =
        active?.status === "running"
          ? "run"
          : active?.status === "verifying"
            ? "verify"
            : dag.done
              ? "ok"
              : active === undefined
                ? "blocked"
                : "next";
      parts.push(t.paint(t.colors.text.muted, `DAG:${dag.completed}/${dag.nodes.length} ${state}`));
    }

    const used = Math.round(ratio * runtime.config.contextWindow);
    parts.push(renderContextCell(ratio, 6, `${tokenCount(used)}/${tokenCount(runtime.config.contextWindow)}`));

    const cacheRead = runtime.cost.snapshot().cacheReadTokens;
    if (cacheRead > 0) {
      parts.push(t.paint(t.colors.text.faint, `CACHE:${Math.round(runtime.cost.cacheHitRatio() * 100)}%`));
    }
    if (runtime.lastCheckpoint !== undefined) {
      parts.push(t.paint(t.colors.text.faint, `CP:${runtime.lastCheckpoint.id}`));
    }
    if (runtime.lastSkillsCreated.length > 0) {
      parts.push(t.paint(t.colors.accent, `SKILL:+${runtime.lastSkillsCreated.join(",")}`));
    }
    const serverBadge = renderServerBadge(runtime.processes.list());
    if (serverBadge !== undefined) parts.push(serverBadge);
    const lspServers = Object.keys(runtime.config.lspServers ?? {}).length;
    parts.push(t.paint(t.colors.text.faint, lspServers > 0 ? "LSP:on" : "LSP:off"));
    if (runtime.subAgentPool.activeCount > 0) {
      parts.push(t.paint(t.colors.feedback.info, `SA:${runtime.subAgentPool.activeCount}`));
    }
    const runningTool = runtime.activeToolSnapshot()[0];
    if (runningTool !== undefined) {
      parts.push(t.paint(t.colors.accent, `TOOL:${runningTool.name} ${formatDuration(runningTool.elapsedMs)}`));
    }
    // The animated activity segment is what tells the user the agent is busy
    // even before the first token arrives.
    const live = activityFrame(activity);
    if (live !== undefined) parts.push(live);
    if (streamTelemetry !== undefined) {
      const seconds = (Date.now() - streamTelemetry.startedAt) / 1000;
      if (seconds >= 0.3) {
        const rate = Math.max(1, Math.round(streamTelemetry.chars / 4 / seconds));
        rateWindow.push(rate);
        parts.push(renderRateCell(rateWindow.last(5)));
      }
    }
    if (runtime.steeringDepth > 0) {
      parts.push(t.paint(t.colors.feedback.warning, `↑${runtime.steeringDepth}`));
    }
    if (queue.length > 0) parts.push(t.paint(t.colors.feedback.warning, `Q:${queue.length}`));
    const spend = runtime.cost.compact();
    if (spend.length > 0) parts.push(t.paint(t.colors.text.faint, spend));
    if (fullscreen && samePath(runtime.config.cwd, homedir())) parts.push(homeIndexHint());
    parts.push(t.paint(t.colors.text.faint, cwd));
    return parts.join(t.paint(t.colors.text.faint, " │ "));
  };

  const showStatus = (): void => {
    if (!interactive) return;
    if (useChrome) {
      refreshHeader();
      chrome.setComposerMode(runtime.config.mode);
      chrome.setStatus(statusLine());
      return;
    }
    printStatusBar({
      mode: runtime.config.mode,
      model: runtime.config.model,
      usedRatio: runtime.contextManager.usedRatio(runtime.history),
      contextWindow: runtime.config.contextWindow,
      ...(runtime.config.effort !== undefined ? { effort: runtime.config.effort } : {}),
    });
  };
  refreshStatus = showStatus;

  /**
   * Paints the toast overlay in the top-right corner. Only the full-screen layout
   * has a fixed region to composite over; inline mode has no stable row, so it
   * skips the overlay rather than corrupting the transcript.
   */
  const paintToasts = (): void => {
    if (!useChrome || !fullscreen) return;
    const width = terminalDimension(process.stderr.columns, 80);
    chrome.setOverlay(toasts.render(width));
  };

  // The event bus is the only place the REPL learns that a skill, checkpoint or
  // compaction happened, so the toasts are wired to it instead of to callbacks.
  // Every tab has its own runtime and bus, so the subscription is rebound on a
  // tab switch rather than pointing at the first tab's bus forever.
  let detachToasts = attachToastBus(runtime.events, toasts);
  /**
   * Live sub-agent fleet: `start` adds a child, `progress` updates its detail and
   * `done`/`failed` removes it. Painted on the same ticker as the phase line, so
   * the row breathes while children run and disappears when the last one settles.
   */
  const applySubAgentStatus = (event: {
    role: string;
    goal: string;
    phase: "start" | "progress" | "done" | "failed";
    detail?: string | undefined;
  }): void => {
    const key = `${event.role}:${event.goal}`;
    if (event.phase === "start") {
      agentFleet.set(key, { role: event.role, goal: event.goal });
    } else if (event.phase === "progress") {
      const entry = agentFleet.get(key);
      if (entry === undefined || event.detail === undefined) return;
      agentFleet.set(key, { ...entry, detail: event.detail });
    } else {
      agentFleet.delete(key);
    }
    if (fullscreen) paintAgents();
  };
  let detachSubAgents = runtime.events.on("subagent.status", applySubAgentStatus);
  const bindToasts = (): void => {
    detachToasts();
    detachSubAgents();
    toasts.dispose();
    detachToasts = attachToastBus(runtime.events, toasts);
    detachSubAgents = runtime.events.on("subagent.status", applySubAgentStatus);
  };

  if (useChrome) chrome.setStatus(statusLine());

  /**
   * Repaints the tab strip and footer for the active tab. Called after every
   * switch, so the strip, the status line and the prompt all describe the same
   * conversation.
   */
  const showTabs = (): void => {
    if (!useChrome) return;
    chrome.setTabs(tabStripLine(tabs.all(), tabs.activeIndex));
    showStatus();
  };

  /**
   * Opens the bottom question box and pauses the steering composer while it
   * owns the keyboard. The box itself clears its rows; Chrome only has to give
   * the terminal back with its footer repainted.
   */
  const askUserWithWizard = async (payload: AskUserPayload): Promise<AskUserResult> => {
    if (!interactive) return autoResolveAskUser(payload);
    const composer = activeComposer;
    composer?.pause();
    if (useChrome) chrome.suspend();
    const height = wizardBoxHeight(payload);
    const rows = process.stderr.rows !== undefined && process.stderr.rows > 0 ? process.stderr.rows : 24;
    const originRow = useChrome ? chrome.wizardOrigin(height) : Math.max(1, rows - height - 1);
    try {
      return await PromptWizardBox.run({
        payload,
        input: process.stdin,
        output: process.stderr,
        originRow,
        boxHeight: height,
      });
    } finally {
      if (useChrome) {
        chrome.resume();
        chrome.moveToRegionBottom();
      }
      composer?.resume();
      showStatus();
    }
  };
  askUserHandler = askUserWithWizard;

  /** Points `runtime` at the tab in `index` and repaints. */
  const activateTab = (index: number): void => {
    tabs.select(index);
    runtime = tabs.current().payload;
    bindToasts();
    showTabs();
    refreshHeader();
    chrome.setComposerMode(runtime.config.mode);
    showStatus();
  };

  /** Opens a fresh tab with an empty conversation and switches to it. */
  const openTab = async (): Promise<void> => {
    const tab = await makeTab(undefined, [], shortTitle("new session"));
    const index = tabs.add(tab);
    activateTab(index);
    if (useChrome) chrome.writeRegion(`${theme().paint(theme().colors.text.faint, `— tab ${index + 1}: ${tab.title} —`)}\n`);
    else process.stderr.write(pc.gray(`— tab ${index + 1} —\n`));
  };

  /** Closes the active tab, unless it is the last one. */
  const closeTab = async (): Promise<void> => {
    const index = tabs.activeIndex;
    if (tabs.size <= 1) {
      printInfo("Only one tab open; /exit to quit.");
      return;
    }
    const closing = tabs.current();
    tabs.close(index);
    runtime = tabs.current().payload;
    bindToasts();
    showTabs();
    await closing.payload.close();
    if (useChrome) chrome.writeRegion(`${theme().paint(theme().colors.text.faint, `— closed tab ${index + 1} —`)}\n`);
    else process.stderr.write(pc.gray(`— closed tab ${index + 1} —\n`));
  };

  /**
   * Full-screen inspector. Sessions are selectable; plan nodes, learned rules
   * and in-flight tools are read-only rows that show their detail when picked.
   */
  const openSidebar = async (): Promise<void> => {
    const t = theme();
    const items: {
      id: string;
      label: string;
      detail?: string;
      section?: string;
      preview?: string[];
    }[] = [];

    const dag = runtime.dag.snapshot();
    for (const node of dag.nodes) {
      items.push({
        id: `plan:${node.id}`,
        section: "Plan",
        label: `${node.id} ${node.status}`,
        detail: shortTitle(node.title, 40),
        preview: [
          `acceptance: ${node.acceptanceCriteria.length > 0 ? node.acceptanceCriteria : "none"}`,
          `deps: ${node.dependencies.join(", ") || "none"} · retries ${node.retryCount}`,
        ],
      });
    }

    for (const rule of runtime.operatorMemory.all()) {
      items.push({
        id: `rule:${rule.id}`,
        section: "Rules",
        label: shortTitle(rule.text, 52),
        detail: `${rule.kind} ×${rule.confirmations}`,
        preview: [rule.source],
      });
    }

    for (const tool of runtime.activeToolSnapshot()) {
      items.push({
        id: `tool:${tool.id}`,
        section: "Running",
        label: `${tool.name} ${formatDuration(tool.elapsedMs)}`,
        detail: tool.id,
        preview: ["in flight"],
      });
    }

    for (const [index, tab] of tabs.all().entries()) {
      const turns = tab.payload.history.filter((message) => message.role === "user").length;
      items.push({
        id: `tab:${index}`,
        section: "Sessions",
        label: `${index + 1}  ${tab.title}`,
        detail: index === tabs.activeIndex ? t.paint(t.colors.accent, "● active") : "",
        preview: [
          `${turns} turn${turns === 1 ? "" : "s"} · ${tab.payload.config.model}`,
          tab.payload.cost.compact() || "no spend yet",
        ],
      });
    }

    const choice = await selectList({
      title: `${t.paint(t.colors.accent, "Inspector")} ${t.paint(t.colors.text.faint, `${items.length} entries`)}`,
      current: `tab:${tabs.activeIndex}`,
      items,
    });
    if (choice === undefined) {
      showStatus();
      return;
    }
    if (choice.id.startsWith("tab:")) {
      activateTab(Number.parseInt(choice.id.slice(4), 10));
      return;
    }
    printInfo(`${choice.section ?? "Inspector"} · ${choice.label}`);
    for (const line of choice.preview ?? []) printInfo(line);
  };

  /** Split inspector content: plan, files, skills and learned rules. */
  const buildInspector = (): string[] => {
    const t = theme();
    const lines: string[] = [t.paint(t.colors.accent, "INSPECTOR")];
    const dag = runtime.dag.snapshot();
    lines.push(`${t.paint(t.colors.text.faint, "PLAN")} ${dag.completed}/${dag.nodes.length}${dag.done ? " ✓" : ""}`);
    for (const node of runtime.dag.all().slice(0, 8)) {
      const glyph =
        node.status === "completed"
          ? "✓"
          : node.status === "running" || node.status === "verifying"
            ? "⠋"
            : node.status === "failed"
              ? "✗"
              : "○";
      lines.push(`${glyph} ${node.id} ${truncate(node.title, 22)}`);
    }
    lines.push("", `${t.paint(t.colors.text.faint, "FILES")} ${runtime.backups.list().length}`);
    for (const entry of runtime.backups.list().slice(-5)) {
      lines.push(`▪ ${truncate(entry.path, 24)}`);
    }
    const skills = runtime.lastSkillsCreated;
    lines.push("", `${t.paint(t.colors.text.faint, "SKILLS")} ${skills.length}`);
    for (const skill of skills.slice(0, 4)) lines.push(`◆ ${truncate(skill, 24)}`);
    const rules = runtime.operatorMemory.all();
    lines.push("", `${t.paint(t.colors.text.faint, "RULES")} ${rules.length}`);
    for (const rule of rules.slice(0, 4)) lines.push(`▪ ${truncate(rule.text, 24)}`);
    return lines;
  };

  /** Toggles the split inspector; force redraws it without changing visibility. */
  const toggleInspector = (refreshOnly = false): void => {
    if (!fullscreen) return;
    if (!refreshOnly) inspectorOpen = !inspectorOpen;
    chrome.setSidebar(inspectorOpen ? buildInspector() : undefined);
  };

  /** Starts the animated footer segment and keeps it ticking. */
  const beginActivity = (label: string): void => {
    activity = { label, startedAt: Date.now() };
    if (useChrome && ticker === undefined) {
      ticker = new AnimationTicker((frame) => {
        showStatus();
        // One clock drives everything that must breathe: the footer segment, the
        // phase line, the sub-agent fleet, the write cursor and every running
        // tool card. When the turn ends the ticker stops, so all of them freeze
        // together instead of one timer per animation.
        tickPhase();
        tickThought();
        agentsTick += 1;
        if (agentFleet.size > 0) paintAgents();
        cursorTick += 1;
        if (streamMarkdown !== undefined) streamMarkdown.setCursor(streamCursor(cursorTick, true) ?? "");
        if (fullscreen) chrome.setSpinner(frame.spinner);
      }, 80);
      ticker.start();
    }
    showStatus();
  };

  const setActivity = (label: string, step?: number, maxSteps?: number): void => {
    if (activity === undefined) return;
    activity = {
      label,
      startedAt: activity.startedAt,
      ...(step !== undefined ? { step } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
    };
  };

  const endActivity = (): void => {
    activity = undefined;
  };

  const stopTicker = (): void => {
    ticker?.stop();
    ticker = undefined;
  };

  /** A fresh Gather -> Act -> Verify state for the turn about to run. */
  const resetPhase = (): void => {
    phase = {
      think: { status: "running", label: "THINKING" },
      act: { status: "pending", label: "TOOLS" },
      verify: { status: "pending", label: "VERIFY" },
      tick: 0,
    };
  };

  const setPhaseCell = (
    key: "think" | "act" | "verify",
    status: PhaseStatus,
    label: string,
    elapsed?: string,
  ): void => {
    if (phase === undefined) return;
    const cell: PhaseCell = elapsed !== undefined ? { status, label, elapsed } : { status, label };
    phase = { ...phase, [key]: cell };
  };

  /** Advances the frame counter and repaints the phase row. */
  const tickPhase = (): void => {
    if (phase === undefined) return;
    phase = { ...phase, tick: phase.tick + 1 };
    paintPhase();
  };

  const paintPhase = (): void => {
    if (!useChrome) return;
    if (phase === undefined) {
      chrome.setPhase(undefined);
      return;
    }
    chrome.setPhase(renderPhaseTimeline(phase, terminalDimension(process.stderr.columns, 80)));
  };

  const clearPhase = (): void => {
    phase = undefined;
    if (useChrome) chrome.setPhase(undefined);
  };

  /**
   * Repaints the live sub-agent fleet row. The row is rebuilt from the map on
   * every frame so a child that finished frees its slot immediately, and the
   * spinner glyph advances with `agentsTick` while any child is still running.
   */
  const paintAgents = (): void => {
    if (!useChrome) return;
    if (agentFleet.size === 0) {
      chrome.setAgents(undefined);
      return;
    }
    chrome.setAgents(
      renderAgentFleet([...agentFleet.values()], agentsTick, terminalDimension(process.stderr.columns, 80)),
    );
  };

  const clearAgents = (): void => {
    agentFleet.clear();
    if (useChrome) chrome.setAgents(undefined);
  };

  /**
   * Live thinking line shown above the phase timeline. It carries the router's
   * classification, the auto-discovered skills and the loop's cognitive
   * transitions, so the operator can see the agent reasoning instead of a blank
   * screen. The most recent line wins; a dim spinner prefix keeps it alive.
   */
  let thoughtText: string | undefined;
  let thoughtTick = 0;
  /** Tail of the provider's native scratchpad, folded into the thinking line. */
  let reasoningTail = "";
  const THOUGHT_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const setThought = (text: string): void => {
    thoughtText = text;
    if (useChrome) chrome.setThought(paintThought());
  };
  const paintThought = (): string => {
    if (thoughtText === undefined) return "";
    const spinner = THOUGHT_SPINNER[thoughtTick % THOUGHT_SPINNER.length] ?? "⠋";
    return theme().paint(theme().colors.text.faint, `${spinner} ${thoughtText}`);
  };
  const tickThought = (): void => {
    thoughtTick += 1;
    if (useChrome && thoughtText !== undefined) chrome.setThought(paintThought());
  };
  const clearThought = (): void => {
    thoughtText = undefined;
    if (useChrome) chrome.setThought(undefined);
  };

  const runGoal = async (goal: string): Promise<void> => {
    busy = true;
    interruptCount = 0;
    composerStoppedByEscape = false;
    reasoningTail = "";
    activeAbort = new AbortController();
    streamTelemetry = undefined;
    rateWindow.clear();
    resetPhase();
    const turnStartedAt = Date.now();
    let turnSteps = 0;
    // The footer carries a live activity segment while a turn runs, so the
    // terminal shows the agent is busy even when the model is silent for a while.
    beginActivity("thinking");
    // The first goal names the tab; later goals leave it, so the strip keeps
    // pointing at what the conversation is about rather than its last message.
    const tab = tabs.current();
    if (tab.title === "main" || tab.title === "new session") {
      tab.title = shortTitle(goal);
      showTabs();
    }
    const markdown = new MarkdownRenderer(useChrome ? process.stderr : process.stdout);
    // Full-screen owns a virtual viewport: complete lines only, no carriage-return
    // live tail that would append itself as history.
    markdown.setLiveTail(!fullscreen);
    streamMarkdown = markdown;
    // In an interactive terminal the coalesced deltas are handed to the smoother
    // instead of straight to the markdown writer, so a bursty model types at a
    // steady pace. A pipe (or `-p`) bypasses it entirely: `smooth:false` forwards
    // every chunk untouched and never creates a timer.
    const smoothStream = new SmoothStreamRenderer({
      smooth: interactive,
      onDrain: (text) => markdown.push(text),
    });
    let streamed = false;
    let reasoningStarted = false;
    let reasoningStartedAt = 0;
    // Read-only calls in one step are collected here and drawn as a single tree
    // instead of one card each, so exploring a workspace does not bury the answer.
    // A mutating tool is never grouped: it flushes the batch and gets its own card.
    let batch: ToolBatch | undefined;
    const batchRunning = new Set<string>();
    let batchBlockId: string | undefined;
    let batchSequence = 0;
    /** Non-groupable tools, tracked by id so their running card can be replaced. */
    const runningTools = new Map<
      string,
      { name: string; detail: string; startedAt: number; blockId: string }
    >();
    const drawBatch = (): void => {
      const current = batch;
      if (current === undefined || !fullscreen) return;
      if (batchBlockId === undefined) batchBlockId = `batch:${++batchSequence}`;
      const blockId = batchBlockId;
      chrome.writeCard(
        blockId,
        ({ spinner, expanded }) =>
          current.render({ width: chrome.current().contentWidth, spinner, expanded }),
        { expandable: true, state: current.settled ? "ok" : "running" },
      );
    };
    const flushBatch = (): void => {
      if (batch === undefined) return;
      drawBatch();
      batch = undefined;
      batchRunning.clear();
      batchBlockId = undefined;
    };
    const toolStart = (id: string, name: string, input: unknown): void => {
      // A mutating tool is never grouped: it closes the current tree and gets its
      // own card, because it changed the workspace and deserves the attention.
      if (!isGroupable(name)) {
        flushBatch();
        if (!fullscreen) return;
        const detail = toolCardDetail(name, input);
        const blockId = `tool:${id}`;
        runningTools.set(id, { name, detail, startedAt: Date.now(), blockId });
        chrome.writeCard(
          blockId,
          ({ spinner, expanded }) =>
            renderToolCard({
              name,
              detail,
              state: "running",
              spinner,
              expanded,
              width: chrome.current().contentWidth,
            }),
          { expandable: true, state: "running" },
        );
        return;
      }
      if (!fullscreen) return;
      if (batch === undefined) batch = new ToolBatch();
      batch.add({ id, name, detail: toolDetail(name, input), summary: "…", state: "running" });
      batchRunning.add(id);
      drawBatch();
    };
    const toolDone = (id: string, name: string, ok: boolean, durationMs: number): void => {
      if (batch === undefined || !batchRunning.has(id)) return;
      batchRunning.delete(id);
      batch.complete(id, ok ? "ok" : "failed", durationMs, toolSummary(name, durationMs));
      drawBatch();
      if (batch.settled) flushBatch();
    };
    /** Turn-end safety net: nothing may survive as a running spinner. */
    const finalizeRunningBlocks = (): void => {
      if (!fullscreen) {
        runningTools.clear();
        return;
      }
      for (const info of runningTools.values()) {
        chrome.writeCard(
          info.blockId,
          ({ spinner, expanded }) =>
            renderToolCard({
              name: info.name,
              detail: info.detail,
              state: "failed",
              durationMs: Date.now() - info.startedAt,
              output: "interrupted by the operator",
              spinner,
              expanded,
              width: chrome.current().contentWidth,
            }),
          { state: "failed" },
        );
      }
      runningTools.clear();
      for (const id of batchRunning) batch?.complete(id, "failed", 0, "interrupted");
      if (batch !== undefined) {
        drawBatch();
        flushBatch();
      }
    };
    // Streaming deltas arrive per token; both renderers are batched to one write
    // per 16 ms frame so a fast model cannot saturate the PTY.
    const reasoningFrames = new FrameCoalescer((chunk) => {
      // Thinking models stream their scratchpad before the answer. Show it dim
      // and clearly separated, so it never reads as the final response.
      if (!reasoningStarted) {
        spinner.stop();
        endActivity();
        reasoningStartedAt = Date.now();
        if (useChrome) {
          chrome.moveToRegionBottom();
          if (fullscreen) chrome.writeBlock([reasoningHeader("Razonando", "0.0s")]);
          else chrome.writeRegion(`\n${theme().paint(theme().colors.text.faint, "✻ pensando")}\n`);
        } else {
          process.stderr.write(`\n${pc.gray("✻ pensando")}\n`);
        }
        reasoningStarted = true;
      }
      const painted = theme().paint(theme().colors.text.faint, chunk);
      if (useChrome) chrome.writeRegion(painted);
      else process.stderr.write(painted);
    });
    const textFrames = new FrameCoalescer((chunk) => {
      if (!streamed) {
        spinner.stop();
        endActivity();
        // Close the reasoning block before the answer starts, or the first word
        // of the answer lands on the last line of the scratchpad.
        if (reasoningStarted) {
          if (useChrome) {
            if (fullscreen) {
              chrome.writeBlock([reasoningFooter(formatDuration(Date.now() - reasoningStartedAt))]);
            } else {
              chrome.writeRegion("\n");
            }
          } else {
            process.stderr.write("\n");
          }
        }
        if (useChrome) chrome.writeRegion(`\n${theme().paint(theme().colors.accent, "◆")} ${theme().bold("carls")}\n`);
        else printAssistantHeader();
        streamed = true;
      }
      smoothStream.push(chunk);
    });
    const flushStreams = (): void => {
      textFrames.flush();
      reasoningFrames.flush();
      // A tool boundary or the end of the turn is where a smooth tail would only
      // delay the next thing the user needs to see, so the smoother empties now.
      smoothStream.flushInstant();
    };
    if (useChrome) chrome.moveToRegionBottom();
    if (!fullscreen) spinner.start("thinking");
    // Typing during a turn queues the message instead of dropping it. The
    // composer owns stdin while it runs, so it must stop before the prompt.
    const composer = interactive
      ? collectTypedLines({
          input: process.stdin,
          output: process.stderr,
          queue,
          // With the fixed layout the footer is redrawn constantly, so only the
          // final "queued" line is printed there.
          echo: !useChrome,
          // The composer stays alive for the whole turn: every keystroke repaints
          // the prompt row so the operator sees what they are typing in real time
          // instead of a frozen screen.
          onDraft: (text) => {
            if (!useChrome) return;
            chrome.drawPrompt(
              `${theme().paint(theme().colors.accent, "❯")} `,
              text,
              text.length,
              "escribiendo steering en vivo...  (Enter: inyectar · Esc: cancelar turno)",
            );
          },
          // Escape with an empty composer aborts the running turn immediately.
          onEscape: () => {
            activeAbort?.abort();
            composerStoppedByEscape = true;
          },
          // Enter steers: the message joins the running turn at its next step
          // boundary. A steer that arrives after the last step is queued below.
          onSubmit: (text) => {
            const outcome = runtime.steer(text);
            if (outcome === "ignored") {
              // The classifier drops approval-like text because it may be an
              // answer to a gate prompt. A line submitted to this composer is a
              // new instruction (the composer is paused while a gate is open),
              // so queue it instead of letting it disappear.
              const depth = queue.push(text);
              const line = `${pc.gray("↳")} ${theme().paint(theme().colors.text.muted, `queued (${depth}): ${text}`)}`;
              if (useChrome) chrome.writeRegion(`${line}\n`);
              else process.stderr.write(`\r\u001b[K${line}\n`);
              return;
            }
            if (outcome === "stop") {
              // A stop must cancel the in-flight turn and its prefetched reads,
              // not just sit in the queue until the next step boundary.
              activeAbort?.abort();
              const line = `${pc.gray("↳")} ${theme().paint(theme().colors.feedback.warning, "stopping")}`;
              if (useChrome) chrome.writeRegion(`${line}\n`);
              else process.stderr.write(`\r\u001b[K${line}\n`);
              return;
            }
            const line = `${pc.gray("↳ steering")} ${theme().paint(theme().colors.text.muted, text)}`;
            if (useChrome) chrome.writeRegion(`${line}\n`);
            else process.stderr.write(`\r\u001b[K${line}\n`);
          },
          // Raw mode swallows Ctrl+C, so raise the signal the handler expects.
          onInterrupt: () => process.kill(process.pid, "SIGINT"),
        })
      : undefined;
    activeComposer = composer;
    // Paint the live composer immediately so the operator sees it is alive and
    // what it accepts before they type the first character.
    if (useChrome) {
      chrome.drawPrompt(
        `${theme().paint(theme().colors.accent, "❯")} `,
        "",
        0,
        "escribiendo steering en vivo...  (Enter: inyectar · Esc: cancelar turno)",
      );
    }
    // Approvals read stdin line by line; the composer steps aside while one is
    // on screen so a "y" cannot also become a steering message.
    runtime.gate.setPromptPause((paused) => {
      if (paused) composer?.pause();
      else composer?.resume();
      // A readline approval would otherwise write into the captured viewport and
      // be invisible. Hand the screen over raw for the duration of the question.
      if (fullscreen) {
        if (paused) chrome.suspend();
        else chrome.resume();
      }
    });
    // The grouped tree is built from the bus, which carries the tool id on every
    // path (prefetched and inline), so a parallel batch is one tree instead of
    // several cards that race each other onto the screen. Subscribed before the
    // turn and detached in the finally, so a later turn cannot stack listeners.
    const detachTools = runtime.events.on("tool.start", ({ id, name, input }) => toolStart(id, name, input));
    const detachToolDone = runtime.events.on("tool.done", ({ id, name, ok, durationMs }) =>
      toolDone(id, name, ok, durationMs),
    );
    // The loop narrates its cognition on the bus (classification, skill activation,
    // reasoning, decision). Rendering it here keeps the agent loop free of any
    // terminal code while still giving the operator a live thinking panel.
    const detachThought = runtime.events.on("agent.thought", ({ text }) => setThought(text));
    // Hybrid thinking: when the provider exposes a native scratchpad
    // (`reasoning_content`), its tail is what the operator wants to watch; the
    // narrated thoughts above remain the fallback for models that emit none.
    const detachReasoning = runtime.events.on("reasoning.delta", ({ text }) => {
      reasoningTail = (reasoningTail + text).slice(-160).replace(/\s+/g, " ").trim();
      setThought(`pensando: ${reasoningTail}`);
    });
    try {
      const result = await runtime.runTurn(goal, {
        signal: activeAbort.signal,
        // The full-screen stream renders tool cards itself; raw stderr lines
        // would bypass the viewport and corrupt the fixed layout.
        quietStderr: fullscreen,
        onSteer: (messages) => {
          const line = `${pc.yellow("↳")} ${pc.gray(`steering applied: ${messages.join(" · ")}`)}`;
          if (useChrome) chrome.writeRegion(`\n${line}\n`);
          else process.stderr.write(`\n${line}\n`);
        },
        onStep: (step, max) => {
          turnSteps = step;
          if (activity === undefined) beginActivity("thinking");
          setActivity("thinking", step, max);
          // A new step means the model is thinking again, and the previous step's
          // tools have settled.
          setPhaseCell("think", "running", "THINKING");
          setPhaseCell("act", "pending", "TOOLS");
          if (!streamed && !useChrome) spinner.start(`thinking · step ${step}/${max}`);
        },
        onToolStart: (name, input) => {
          const detail = toolLabel(name, input);
          if (activity === undefined) beginActivity(detail);
          else setActivity(detail);
          setPhaseCell("think", "done", "THINK");
          setPhaseCell("act", "running", `ACT: ${detail}`);
        },
        onReasoning: (chunk) => {
          reasoningFrames.push(chunk);
        },
        onText: (chunk) => {
          if (streamTelemetry === undefined) streamTelemetry = { chars: 0, startedAt: Date.now() };
          streamTelemetry.chars += chunk.length;
          textFrames.push(chunk);
        },
        onToolResult: (name, toolResult, durationMs) => {
          // The model may narrate and then call a tool in the same turn. Flush
          // the coalescer first so the narration reaches the markdown buffer
          // before the next tool block is appended.
          flushStreams();
          if (streamed) markdown.flush();
          if (reasoningStarted && !streamed) {
            if (useChrome) {
              if (fullscreen) chrome.writeBlock([reasoningFooter(formatDuration(Date.now() - reasoningStartedAt))]);
              else chrome.writeRegion("\n");
            } else {
              process.stderr.write("\n");
            }
            // The next step is a fresh model call, so it gets its own header.
            reasoningStarted = false;
          }
          if (fullscreen) {
            // The running card was created under `tool:<id>` when the bus emitted
            // tool.start. Replace that exact block with its terminal state; never
            // append a second card, which is what left the spinner frozen above.
            const running = [...runningTools.entries()].find(([, info]) => info.name === name);
            if (running !== undefined && !isGroupable(name)) {
              const [id, info] = running;
              const exitCode =
                typeof toolResult.metadata?.exitCode === "number" ? toolResult.metadata.exitCode : undefined;
              const body = toolResult.ok
                ? toolResult.output
                : `${toolResult.error ?? "failed"}\n${toolResult.output}`.trim();
              chrome.writeCard(
                info.blockId,
                ({ spinner, expanded }) =>
                  renderToolCard({
                    name,
                    detail: info.detail,
                    state: toolResult.ok ? "ok" : "failed",
                    durationMs,
                    ...(exitCode !== undefined ? { exitCode } : {}),
                    output: body,
                    spinner,
                    expanded,
                    width: chrome.current().contentWidth,
                  }),
                { expandable: true, state: toolResult.ok ? "ok" : "failed" },
              );
              runningTools.delete(id);
            }
            if (inspectorOpen) toggleInspector(true);
          }
          setPhaseCell("act", "done", "ACT");
          if (!streamed) setActivity("thinking");
        },
      });
      flushStreams();
      spinner.stop();
      endActivity();
      markdown.flush();
      if (!streamed && result.finalText.length > 0) {
        if (useChrome) chrome.writeRegion(`\n${theme().paint(theme().colors.accent, "◆")} ${theme().bold("carls")}\n`);
        else printAssistantHeader();
        markdown.push(result.finalText);
        markdown.flush();
      }
      if (result.stoppedReason === "aborted") {
        if (composerStoppedByEscape) {
          const banner = `${pc.red("✗")} ${pc.bold("Turno interrumpido por el operador")} ${pc.gray("[ESC]")}`;
          if (useChrome) chrome.writeRegion(`\n${pc.gray("╭─")} ${banner} ${pc.gray("─".repeat(Math.max(0, 20)))}\n`);
          else process.stderr.write(`\n${pc.gray("╭─")} ${banner} ${pc.gray("─".repeat(20))}\n`);
        } else {
          printInfo("Stopped.");
        }
      } else if (result.stoppedReason === "max_steps") printError(result.finalText);
      // The closing line is what tells the user the agent stopped rather than
      // hung: it reports the wall-clock time, the step count and the spend.
      const spend = runtime.cost.compact();
      const summary = { durationMs: Date.now() - turnStartedAt, steps: turnSteps, stoppedReason: result.stoppedReason, tokens: spend };
      if (useChrome) chrome.writeRegion(`${turnSummaryLine(summary)}\n`);
      else printTurnSummary(summary);
    } catch (error) {
      flushStreams();
      spinner.stop();
      markdown.flush();
      printError((error as Error).message);
    } finally {
      detachTools();
      detachToolDone();
      detachThought();
      detachReasoning();
      // No tool card may survive the turn in `running`: the sweep turns every
      // remaining spinner into its terminal state before the frame settles.
      finalizeRunningBlocks();
      flushBatch();
      streamMarkdown = undefined;
      textFrames.dispose();
      reasoningFrames.dispose();
      smoothStream.dispose();
      runtime.gate.setPromptPause(undefined);
      composer?.stop();
      activeComposer = undefined;
      // A steer that arrived too late to reach a step boundary still runs.
      for (const leftover of runtime.takeSteering()) queue.push(leftover);
      busy = false;
      activeAbort = undefined;
      // The timer must stop even on the error path, or it keeps repainting the
      // footer after the turn is over.
      endActivity();
      stopTicker();
      clearPhase();
      clearThought();
      clearAgents();
      reasoningTail = "";
      streamTelemetry = undefined;
      if (useChrome) {
        chrome.writeRegion("\n");
        chrome.moveToRegionBottom();
        // The turn is over, so the composer returns to its idle prompt text
        // instead of the live-steering placeholder.
        chrome.clearPrompt();
      } else {
        process.stdout.write("\n");
      }
      showStatus();
      if (useChrome) chrome.finishTurn();
      // The prompt is next and must find a live stream and a visible cursor.
      // This is deliberately a resume, never a pause: on ConPTY a pause here
      // can survive the next resume and leave the keyboard unread.
      if (interactive) process.stdin.resume();
    }
  };

  /** Runs everything queued while a turn was running, in order. */
  const drainQueued = async (): Promise<void> => {
    await drainQueue(queue, async (queued) => {
      lastGoal = queued;
      echoUser(queued);
      const queuedExpanded = expandMentions(queued, runtime.config.cwd);
      if (queuedExpanded.attached.length > 0) {
        printInfo(`attached ${queuedExpanded.attached.join(", ")}`);
      }
      for (const skip of queuedExpanded.skipped) {
        printInfo(`could not attach ${skip.path} (${skip.reason})`);
      }
      await runGoal(queuedExpanded.text);
    });
  };

  /** Commands that temporarily own the screen (selectors, wizard, editors). */
  const needsScreen = (line: string): boolean => {
    const [name, ...args] = line.trim().split(/\s+/);
    switch (name) {
      case "/resume":
      case "/sessions":
        return args.length === 0;
      case "/models":
      case "/setup":
      case "/configure":
      case "/editor":
      case "/update":
        return true;
      case "/agents":
        return args.length === 0;
      case "/tab":
      case "/tabs":
        return args.length > 0 && args[0] !== "list";
      default:
        return false;
    }
  };

  try {
    // A resumed session restores the model's history but not the screen. Replay
    // the tail of the log as compact cards so what the operator sees matches the
    // context the model is actually holding, instead of an empty transcript.
    hydrateHistory(options.resumeMessages ?? []);
    // Text to resume the prompt with: a mention re-opens the line the user was
    // editing instead of starting over.
    let resume: string | undefined;
    for (;;) {
      let input: string;
      if (interactive) {
        const result = await prompt.read({
          prompt: promptGlyph(),
          ...(resume !== undefined ? { initial: resume } : {}),
          onModeCycle: cycleMode,
          onPalette: () => true,
          runtime,
          onExpand: expandLast,
          onScrollKey: (key, empty) => chrome.handleScrollKey(key, empty),
          ...(useChrome ? { chrome } : {}),
        });
        resume = undefined;
        if (result.type === "eof") {
          shutdownRequested = true;
          break;
        }
        if (result.type === "new-tab") {
          await openTab();
          continue;
        }
        if (result.type === "close-tab") {
          await closeTab();
          continue;
        }
        if (result.type === "next-tab") {
          activateTab((tabs.activeIndex + 1) % tabs.size);
          continue;
        }
        if (result.type === "sidebar") {
          if (fullscreen) {
            toggleInspector();
            continue;
          }
          if (useChrome) chrome.suspend();
          try {
            await openSidebar();
          } finally {
            if (useChrome) chrome.resume();
          }
          continue;
        }
        if (result.type === "mention") {
          // The picker is full-screen, so release the scrolling region around it.
          if (useChrome) chrome.suspend();
          let picked: string | undefined;
          try {
            picked = await pickMention();
          } finally {
            if (useChrome) chrome.resume();
          }
          resume = picked === undefined ? result.draft : `${result.draft}@${picked} `;
          continue;
        }
        if (result.type === "palette") {
          // The palette is a full-screen selector, so the scrolling region has to
          // be released first or its frame lands inside the fixed header area.
          if (useChrome) chrome.suspend();
          let chosen: string | undefined;
          try {
            chosen = await openCommandPalette(runtime, result.filter);
          } finally {
            if (useChrome) chrome.resume();
          }
          if (chosen === undefined) {
            showStatus();
            continue;
          }
          // Re-enter the normal dispatch path with the chosen command, so the
          // palette never needs to know how a command runs.
          input = chosen;
          if (useChrome) {
            chrome.writeRegion(`${promptGlyph()}${theme().paint(theme().colors.text.muted, chosen)}\n`);
          } else {
            process.stderr.write(`${promptGlyph()}${theme().paint(theme().colors.text.muted, chosen)}\n`);
          }
        } else {
        if (result.type === "interrupt") {
          // Idle Ctrl+C exits immediately and prints the resume banner; there
          // is no half-finished turn to protect any more.
          shutdownRequested = true;
          break;
        }
          if (result.type !== "line") continue;
          input = result.text.trim();
          echoUser(input);
        }
      } else {
        const line = await reader.next(pc.cyan("❯ "));
        if (line === null) {
          shutdownRequested = true;
          break;
        }
        input = line.trim();
      }
      interruptCount = 0;

      if (input.length === 0) continue;

      if (input.startsWith("/")) {
        // Selectors and spawned editors own the screen; text commands stream
        // their output into the virtual viewport instead of vanishing on resume.
        const suspendCommand = useChrome && (!fullscreen || needsScreen(input));
        if (suspendCommand) chrome.suspend();
        let shouldExit = false;
        try {
          shouldExit = await runCommand(input, {
            runtime,
            tabs: {
              list: () =>
                tabs.all().map((tab, index) => ({ title: tab.title, active: index === tabs.activeIndex })),
              open: openTab,
              close: closeTab,
              next: () => activateTab((tabs.activeIndex + 1) % tabs.size),
              // The command dispatch already suspended the scrolling region.
              sidebar: openSidebar,
            },
            retryLast: async () => {
              if (lastGoal === undefined) {
                printInfo("Nothing to retry yet.");
                return;
              }
              await runGoal(lastGoal);
              await drainQueued();
            },
            // /editor hands its text back to the same prompt line.
            composePrompt: (text: string) => {
              resume = text;
            },
            // /expand toggles the newest card without a keyboard chord.
            expand: expandLast,
            // /resume swaps the history in place; repaint its tail so the screen
            // does not keep showing the previous session.
            onHistoryLoaded: (messages) => hydrateHistory(messages),
          });
        } finally {
          if (suspendCommand) chrome.resume();
        }
        if (shouldExit) {
          shutdownRequested = true;
          break;
        }
        // A command can change the mode or the model (/mode, /model), so the
        // footer is refreshed here rather than only after a turn.
        showStatus();
        continue;
      }

      if (input.startsWith("!")) {
        const command = input.slice(1).trim();
        if (command.length > 0) {
          if (fullscreen) chrome.suspend();
          try {
            runShellPassthrough(command, runtime.config.cwd);
          } finally {
            if (fullscreen) chrome.resume();
          }
        }
        continue;
      }

      if (input.startsWith("#")) {
        const note = input.slice(1).trim();
        if (note.length > 0) {
          runtime.addNote(note);
          printInfo("Note added to the session context.");
        }
        continue;
      }

      // `@path` becomes the file's content in this message, so the model does
      // not have to spend a tool call on a file the user already pointed at.
      const expanded = expandMentions(input, runtime.config.cwd);
      if (expanded.attached.length > 0) {
        printInfo(`attached ${expanded.attached.join(", ")}`);
      }
      for (const skip of expanded.skipped) {
        printInfo(`could not attach ${skip.path} (${skip.reason})`);
      }

      lastGoal = input;
      await runGoal(expanded.text);

      // Queued while the turn ran; each one expands its own mentions.
      await drainQueued();
    }
  } finally {
    process.off("SIGINT", onSigint);
    if (useChrome) process.off("SIGWINCH", onResize);
    spinner.stop();
    chrome.disable();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    await closeBrowser();
    // Every tab owns a runtime, an MCP client set and a session-end hook, so all
    // of them have to be flushed and closed, not just the one on screen.
    for (const tab of tabs.all()) tab.payload.flushState();
    await Promise.all(tabs.all().map((tab) => tab.payload.close()));
    // Print after the runtimes are closed so a shutdown hook cannot overwrite
    // the one block the operator needs to copy. Piped runs stay banner-free.
    if (shutdownRequested && interactive) {
      writeSessionBanner(process.stderr, tabs.current().id, turnCount(tabs.current().payload));
    }
  }
  return 0;
}

export function resolveConfigForCli(
  base: ResolvedConfig,
  overrides: ConfigOverrides,
): ResolvedConfig {
  const merged = loadConfig(overrides, base.cwd);
  return overrides.model !== undefined ? { ...merged, model: overrides.model } : merged;
}
