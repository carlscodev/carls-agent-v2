import pc from "picocolors";
import { isKeylessProvider, loadConfig } from "./config/Config.js";
import { Logger } from "./utils/Logger.js";
import { SessionStore } from "./core/SessionStore.js";
import { Runtime, packageVersion } from "./core/Runtime.js";
import { parseArgs, ArgError, HELP_TEXT } from "./cli/ArgsParser.js";
import { runRepl } from "./cli/REPL.js";
import { printInfo } from "./cli/TerminalUI.js";
import { runOneShot } from "./cli/OneShot.js";
import { resolveApiKey } from "./providers/ProviderBase.js";
import { needsOnboarding, runOnboarding } from "./setup/Onboarding.js";
import { formatProviderTable } from "./cli/ProviderList.js";
import { enableWindowsVirtualTerminal } from "./utils/platform.js";
import { installConsoleRestoreHooks } from "./os/WindowsCompat.js";
import { installWindows, uninstallWindows } from "./os/WindowsInstall.js";
import { collectDoctorRows } from "./cli/Doctor.js";
import { announceUpdate, runUpdate } from "./update/Updater.js";
import { applyPreset, discoverAgents, findAgent } from "./agents/Presets.js";
import { join } from "node:path";

async function main(): Promise<number> {
  // Windows consoles need this before any ANSI colour or cursor control works.
  enableWindowsVirtualTerminal();
  // A crash or a killed console must still hand back a visible cursor and an
  // unsynchronised output stream, or PowerShell/CMD look frozen afterwards.
  installConsoleRestoreHooks();

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`${pc.red("error:")} ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (args.installWin || args.uninstallWin) {
    // Installation must work before onboarding and without a provider key: it is
    // the first command a fresh Windows user runs.
    try {
      if (args.installWin) installWindows();
      else uninstallWindows();
      return 0;
    } catch (error) {
      process.stderr.write(`${pc.red("error:")} ${(error as Error).message}\n`);
      return 2;
    }
  }
  if (args.listProviders) {
    process.stdout.write(formatProviderTable());
    return 0;
  }
  if (args.doctor) {
    // Diagnostics must work with a broken or missing credential, so this runs
    // before the onboarding and key checks.
    const loaded = loadConfig(args.overrides);
    process.stdout.write(`${(await collectDoctorRows(loaded)).join("\n")}\n`);
    return 0;
  }
  if (args.update) {
    // Updating must not need a provider, a key or an onboarded config: a broken
    // install is exactly when it is needed.
    return runUpdate({
      check: args.updateCheck,
      ...(args.updateRef !== undefined ? { ref: args.updateRef } : {}),
      ...(args.updateDryRun === true ? { dryRun: true } : {}),
    });
  }

  // First run, or an explicit request: run setup before anything else so the
  // rest of the program always has a provider and a credential.
  let config = loadConfig(args.overrides);
  if (args.setup || needsOnboarding(config)) {
    const preset = {
      ...(args.overrides.provider !== undefined ? { provider: args.overrides.provider } : {}),
      ...(args.overrides.model !== undefined ? { model: args.overrides.model } : {}),
      ...(args.overrides.baseUrl !== undefined ? { baseUrl: args.overrides.baseUrl } : {}),
      ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    };
    const result = await runOnboarding({ preset });
    if (result.cancelled) {
      process.stderr.write(
        `${pc.yellow("Setup cancelled.")} ${pc.gray("Run carls --setup when you are ready.")}\n`,
      );
      return 2;
    }
    config = loadConfig(args.overrides);
    // `carls --setup` on its own is a configuration command, not a session.
    if (args.setup && args.query === undefined && args.resume === undefined) {
      process.stderr.write(
        `${pc.gray("Setup finished. Run")} ${pc.bold("carls")} ${pc.gray("to start, or")} ${pc.bold("carls --doctor")} ${pc.gray("to verify.")}\n`,
      );
      return 0;
    }
  }

  // An agent preset is folded into the config before anything reads it, so the
  // model, mode and tool set are right from the first request.
  if (args.agent !== undefined) {
    const presets = discoverAgents(config.cwd);
    const preset = findAgent(presets, args.agent);
    if (preset === undefined) {
      process.stderr.write(
        `${pc.red("error:")} unknown agent "${args.agent}". ` +
          (presets.length > 0
            ? `Available: ${presets.map((entry) => entry.name).join(", ")}.\n`
            : `No presets found in ${join(config.cwd, ".agents", "agents")}.\n`),
      );
      return 2;
    }
    config = applyPreset(config, preset);
    printInfo(`agent ${preset.name}${preset.mode !== undefined ? ` · ${preset.mode}` : ""}`);
  }

  const logger = new Logger(config.logLevel);

  // A keyless backend (Ollama, LM Studio, vLLM, llama.cpp) serves requests
  // without credentials, so the missing-key check must not apply to it.
  if (resolveApiKey(config) === undefined && !isKeylessProvider(config.provider)) {
    process.stderr.write(
      `${pc.red("error:")} missing credentials for provider "${config.provider}".\n` +
        `${pc.gray(`Set ${config.apiKeyEnv} in your environment, add "apiKey" to .carlsrc.json, or run carls --setup.`)}\n`,
    );
    return 2;
  }

  if (args.resume !== undefined && args.resume !== "latest") {
    const messages = SessionStore.loadMessages(args.resume);
    if (messages.length === 0) {
      logger.warn(`Session ${args.resume} has no messages; starting fresh.`);
    }
  }

  if (args.query !== undefined && args.printMode) {
    return runOneShot(args.query, config, logger);
  }
  if (args.query !== undefined) {
    return runOneShot(args.query, config, logger);
  }

  let resumeMessages: import("./types/llm.js").Message[] = [];
  let sessionId: string | undefined;
  if (args.resume !== undefined) {
    const entry =
      args.resume === "latest"
        ? SessionStore.latestForCwd(config.cwd)
        : { id: args.resume };
    if (entry) {
      sessionId = entry.id;
      resumeMessages = SessionStore.loadMessages(entry.id);
      printInfo(`Resumed session ${entry.id} (${resumeMessages.length} messages).`);
    } else {
      printInfo("No prior session found for this directory; starting fresh.");
    }
  }

  // Fire-and-forget: one cached GitHub call per 24h, stderr only, never awaited
  // so a slow or blocked network cannot delay the prompt. With autoUpdate
  // "auto" this also installs the newer release, once per version.
  void announceUpdate(config.autoUpdate);

  const code = await runRepl({
    config,
    overrides: {},
    noAltScreen: args.noAltScreen,
    ...(sessionId !== undefined ? { sessionId } : {}),
    resumeMessages,
  });
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${pc.red("fatal:")} ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
