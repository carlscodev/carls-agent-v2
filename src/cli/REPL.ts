import pc from "picocolors";
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
import { formatDuration } from "./Text.js";
import { restoreTerminal, writeSessionBanner } from "./SessionBanner.js";

export interface SessionOptions {
  overrides: Partial<ResolvedConfig>;
  config: ResolvedConfig;
  sessionId?: string;
  resumeMessages?: import("../types/llm.js").Message[];
}

export async function runRepl(options: SessionOptions): Promise<number> {
  const logger = new Logger(options.config.logLevel);

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
  if (useChrome) {
    chrome.enable(banner);
  } else {
    process.stderr.write(`${banner.join("\n")}\n\n`);
  }
  const spinner = new Spinner();
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
  /**
   * Live activity, shown in the footer while a turn runs. A silent model looks
   * identical to a hung process, so the footer carries what the agent is doing
   * right now, how long it has been doing it, and which step it is on.
   */
  let activity: { label: string; startedAt: number; step?: number; maxSteps?: number } | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
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
   * Ctrl+O reprints the last collapsed block in full. A terminal cannot rewrite
   * lines it has already scrolled away, so the expansion is appended: the block
   * is shown again, complete, below the collapsed form.
   */
  const expandLast = (): void => {
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
    // Repaint the footer here: the status line is only redrawn after a turn, so
    // without this the mode changes silently and the footer keeps showing the
    // old mode until the next prompt completes.
    showStatus();
    return next;
  };

  /** `❯` marks the input everywhere, so the transcript and the prompt agree. */
  const promptGlyph = (): string => `${theme().paint(theme().colors.accent, "❯")} `;

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
    const used = Math.round(ratio * runtime.config.contextWindow);
    const paint =
      ratio > 0.85 ? t.colors.feedback.error : ratio > 0.7 ? t.colors.feedback.warning : t.colors.text.faint;
    const home = process.env.HOME;
    const cwd =
      home !== undefined && home.length > 1 && runtime.config.cwd.startsWith(home)
        ? `~${runtime.config.cwd.slice(home.length)}`
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

    const percent = Math.round(ratio * 100);
    parts.push(t.paint(paint, `CTX:${percent}% ${tokenCount(used)}/${tokenCount(runtime.config.contextWindow)}`));

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
    if (runtime.steeringDepth > 0) {
      parts.push(t.paint(t.colors.feedback.warning, `↑${runtime.steeringDepth}`));
    }
    if (queue.length > 0) parts.push(t.paint(t.colors.feedback.warning, `Q:${queue.length}`));
    const spend = runtime.cost.compact();
    if (spend.length > 0) parts.push(t.paint(t.colors.text.faint, spend));
    parts.push(t.paint(t.colors.text.faint, cwd));
    return parts.join(t.paint(t.colors.text.faint, " │ "));
  };

  const showStatus = (): void => {
    if (!interactive) return;
    if (useChrome) {
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
    showTabs();
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

  /** Starts the animated footer segment and keeps it ticking. */
  const beginActivity = (label: string): void => {
    activity = { label, startedAt: Date.now() };
    if (activityTimer === undefined && useChrome) {
      activityTimer = setInterval(() => chrome.setStatus(statusLine()), 90);
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
    if (activityTimer !== undefined) {
      clearInterval(activityTimer);
      activityTimer = undefined;
    }
  };

  const runGoal = async (goal: string): Promise<void> => {
    busy = true;
    interruptCount = 0;
    activeAbort = new AbortController();
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
    // Redraw the line being received so code and prose are visible as they
    // stream, instead of appearing only once a newline arrives.
    markdown.setLiveTail(true);
    let streamed = false;
    let reasoningStarted = false;
    // Streaming deltas arrive per token; both renderers are batched to one write
    // per 16 ms frame so a fast model cannot saturate the PTY.
    const reasoningFrames = new FrameCoalescer((batch) => {
      // Thinking models stream their scratchpad before the answer. Show it dim
      // and clearly separated, so it never reads as the final response.
      if (!reasoningStarted) {
        spinner.stop();
        endActivity();
        if (useChrome) {
          chrome.moveToRegionBottom();
          chrome.writeRegion(`\n${theme().paint(theme().colors.text.faint, "✻ pensando")}\n`);
        } else {
          process.stderr.write(`\n${pc.gray("✻ pensando")}\n`);
        }
        reasoningStarted = true;
      }
      const painted = theme().paint(theme().colors.text.faint, batch);
      if (useChrome) chrome.writeRegion(painted);
      else process.stderr.write(painted);
    });
    const textFrames = new FrameCoalescer((batch) => {
      if (!streamed) {
        spinner.stop();
        endActivity();
        // Close the reasoning block before the answer starts, or the first word
        // of the answer lands on the last line of the scratchpad.
        if (reasoningStarted) {
          if (useChrome) chrome.writeRegion("\n");
          else process.stderr.write("\n");
        }
        if (useChrome) chrome.writeRegion(`\n${theme().paint(theme().colors.accent, "◆")} ${theme().bold("carls")}\n`);
        else printAssistantHeader();
        streamed = true;
      }
      markdown.push(batch);
    });
    const flushStreams = (): void => {
      textFrames.flush();
      reasoningFrames.flush();
    };
    if (useChrome) chrome.moveToRegionBottom();
    spinner.start("thinking");
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
    // Approvals read stdin line by line; the composer steps aside while one is
    // on screen so a "y" cannot also become a steering message.
    runtime.gate.setPromptPause((paused) => {
      if (paused) composer?.pause();
      else composer?.resume();
    });
    try {
      const result = await runtime.runTurn(goal, {
        signal: activeAbort.signal,
        onSteer: (messages) => {
          const line = `${pc.yellow("↳")} ${pc.gray(`steering applied: ${messages.join(" · ")}`)}`;
          if (useChrome) chrome.writeRegion(`\n${line}\n`);
          else process.stderr.write(`\n${line}\n`);
        },
        onStep: (step, max) => {
          turnSteps = step;
          setActivity("thinking", step, max);
          if (!streamed && !useChrome) spinner.start(`thinking · step ${step}/${max}`);
        },
        onToolStart: (name, input) => {
          setActivity(toolLabel(name, input));
        },
        onReasoning: (chunk) => {
          reasoningFrames.push(chunk);
        },
        onText: (chunk) => {
          textFrames.push(chunk);
        },
        onToolResult: () => {
          // The model may narrate and then call a tool in the same turn. Flush
          // the coalescer first so the narration reaches the markdown buffer
          // before the next tool block is appended.
          flushStreams();
          if (streamed) markdown.flush();
          if (reasoningStarted && !streamed) {
            if (useChrome) chrome.writeRegion("\n");
            else process.stderr.write("\n");
            // The next step is a fresh model call, so it gets its own header.
            reasoningStarted = false;
          }
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
      if (result.stoppedReason === "aborted") printInfo("Stopped.");
      else if (result.stoppedReason === "max_steps") printError(result.finalText);
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
      textFrames.dispose();
      reasoningFrames.dispose();
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
      if (useChrome) {
        chrome.writeRegion("\n");
        chrome.moveToRegionBottom();
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
      const echo = `${promptGlyph()}${queued}`;
      if (useChrome) chrome.writeRegion(`${echo}\n`);
      else process.stderr.write(`${echo}\n`);
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

  try {
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
          if (useChrome) {
            chrome.writeRegion(`${promptGlyph()}${input}\n`);
          } else {
            process.stderr.write(`${promptGlyph()}${input}\n`);
          }
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
        // Selectors take over the terminal; give them a clean screen and restore
        // the scrolling region afterwards, otherwise the frame lands inside it.
        if (useChrome) chrome.suspend();
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
          });
        } finally {
          if (useChrome) chrome.resume();
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
        if (command.length > 0) runShellPassthrough(command, runtime.config.cwd);
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
