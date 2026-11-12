import pc from "picocolors";
import type { ResolvedConfig, ConfigOverrides } from "../config/Config.js";
import { loadConfig } from "../config/Config.js";
import { Logger } from "../utils/Logger.js";
import { SessionStore } from "../core/SessionStore.js";
import { Runtime } from "../core/Runtime.js";
import { Spinner, bannerLines, modeTag, printAssistantHeader, printCost, printError, printInfo, printStatusBar } from "./TerminalUI.js";
import { Chrome } from "./Chrome.js";
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
import { PromptQueue, collectTypedLines, drainQueue } from "./Queue.js";
import { selectList } from "./SelectList.js";

export interface SessionOptions {
  overrides: Partial<ResolvedConfig>;
  config: ResolvedConfig;
  sessionId?: string;
  resumeMessages?: import("../types/llm.js").Message[];
}

export async function runRepl(options: SessionOptions): Promise<number> {
  const logger = new Logger(options.config.logLevel);
  const session = new SessionStore(options.config.cwd, options.config.model, options.sessionId);
  const runtime = new Runtime(
    { config: options.config, logger, session },
    options.resumeMessages ?? [],
  );
  await runtime.connectMcpServers();
  await runtime.start();

  const banner = bannerLines({
    model: options.config.model,
    provider: options.config.provider,
    cwd: options.config.cwd,
    sessionId: session.id,
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
  let interruptCount = 0;
  let lastGoal: string | undefined;
  let activeAbort: AbortController | undefined;

  const onSigint = (): void => {
    if (busy && activeAbort) {
      process.stderr.write(`\n${pc.yellow("Interrupting…")}\n`);
      activeAbort.abort();
      return;
    }
    interruptCount++;
    if (interruptCount >= 2) {
      process.stderr.write("\n");
      process.exit(0);
    }
    process.stderr.write(`\n${pc.gray("Press Ctrl+C again to exit, or type /exit.")}\n`);
  };
  process.on("SIGINT", onSigint);

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

  /** One dense line: agent, model, context pressure, spend, location. */
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
    if (queue.length > 0) parts.push(t.paint(t.colors.feedback.warning, `↑${queue.length} queued`));
    parts.push(t.paint(paint, `${tokenCount(used)}/${tokenCount(runtime.config.contextWindow)}`));
    parts.push(t.paint(t.colors.text.faint, runtime.cost.format()));
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

  const runGoal = async (goal: string): Promise<void> => {
    busy = true;
    interruptCount = 0;
    activeAbort = new AbortController();
    const markdown = new MarkdownRenderer(useChrome ? process.stderr : process.stdout);
    let streamed = false;
    if (useChrome) chrome.moveToRegionBottom();
    spinner.start("thinking");
    // Typing during a turn queues the message instead of dropping it. The
    // composer owns stdin while it runs, so it must stop before the prompt.
    const stopComposer = interactive
      ? collectTypedLines({
          input: process.stdin,
          output: process.stderr,
          queue,
          // With the fixed layout the footer is redrawn constantly, so only the
          // final "queued" line is printed there.
          echo: !useChrome,
          onQueued: (text, depth) => {
            const line = `${pc.gray("↳ queued")} ${pc.gray(depth > 1 ? `(${depth}) ` : "")}${theme().paint(theme().colors.text.muted, text)}`;
            if (useChrome) chrome.writeRegion(`${line}\n`);
            else process.stderr.write(`\r\u001b[K${line}\n`);
          },
          // Raw mode swallows Ctrl+C, so raise the signal the handler expects.
          onInterrupt: () => process.kill(process.pid, "SIGINT"),
        })
      : undefined;
    try {
      const result = await runtime.runTurn(goal, {
        signal: activeAbort.signal,
        onStep: (step, max) => {
          if (!streamed) spinner.start(`thinking · step ${step}/${max}`);
        },
        onText: (chunk) => {
          if (!streamed) {
            spinner.stop();
            if (useChrome) chrome.writeRegion(`\n${theme().paint(theme().colors.accent, "◆")} ${theme().bold("carls")}\n`);
            else printAssistantHeader();
            streamed = true;
          }
          markdown.push(chunk);
        },
        onToolResult: () => {
          // A model may narrate and then call a tool in the same turn. The
          // narration has no trailing newline, so without this the next tool
          // block is appended to the last word of the sentence.
          if (streamed) markdown.flush();
        },
      });
      spinner.stop();
      markdown.flush();
      if (!streamed && result.finalText.length > 0) {
        if (useChrome) chrome.writeRegion(`\n${theme().paint(theme().colors.accent, "◆")} ${theme().bold("carls")}\n`);
        else printAssistantHeader();
        markdown.push(result.finalText);
        markdown.flush();
      }
      if (result.stoppedReason === "aborted") printInfo("Stopped.");
      else if (result.stoppedReason === "max_steps") printError(result.finalText);
      printCost(`cost ${runtime.cost.format()}`);
    } catch (error) {
      spinner.stop();
      markdown.flush();
      printError((error as Error).message);
    } finally {
      stopComposer?.();
      busy = false;
      activeAbort = undefined;
      if (useChrome) {
        chrome.writeRegion("\n");
        chrome.moveToRegionBottom();
      } else {
        process.stdout.write("\n");
      }
      showStatus();
    }
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
          ...(useChrome ? { chrome } : {}),
        });
        resume = undefined;
        if (result.type === "eof") break;
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
          interruptCount += 1;
          if (interruptCount >= 2) break;
          process.stderr.write(`${pc.gray("Press Ctrl+C again to exit, or type /exit.")}\n`);
          continue;
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
        if (line === null) break;
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
            retryLast: async () => {
              if (lastGoal === undefined) {
                printInfo("Nothing to retry yet.");
                return;
              }
              await runGoal(lastGoal);
            },
            // /editor hands its text back to the same prompt line.
            composePrompt: (text: string) => {
              resume = text;
            },
          });
        } finally {
          if (useChrome) chrome.resume();
        }
        if (shouldExit) break;
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
      await drainQueue(queue, async (queued) => {
        lastGoal = queued;
        const echo = `${promptGlyph()}${queued}`;
        if (useChrome) chrome.writeRegion(`${echo}\n`);
        else process.stderr.write(`${echo}\n`);
        const queuedExpanded = expandMentions(queued, runtime.config.cwd);
        if (queuedExpanded.attached.length > 0) {
          printInfo(`attached ${queuedExpanded.attached.join(", ")}`);
        }
        await runGoal(queuedExpanded.text);
      });
    }
  } finally {
    process.off("SIGINT", onSigint);
    if (useChrome) process.off("SIGWINCH", onResize);
    spinner.stop();
    chrome.disable();
    await closeBrowser();
    await runtime.close();
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
