import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { Effort, PermissionMode } from "../config/Config.js";
import { EFFORTS, PERMISSION_MODES } from "../config/Config.js";
import type { Runtime } from "../core/Runtime.js";
import { SessionStore } from "../core/SessionStore.js";
import { fetchModels, knownModelsFor, type ModelInfo } from "../models/Catalog.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { renderModelList, selectModel } from "../models/Selector.js";
import { printError, printInfo, printPanel } from "./TerminalUI.js";
import { refreshTheme, theme } from "./Theme.js";
import { selectList } from "./SelectList.js";
import { runOnboarding } from "../setup/Onboarding.js";
import { formatProviderTable } from "./ProviderList.js";
import { collectDoctorRows } from "./Doctor.js";
import { loadConfig, specFor } from "../config/Config.js";
import { apiKeyEnvFor } from "../config/Config.js";

export interface CommandContext {
  runtime: Runtime;
  /** Re-runs the most recent user message, used by /retry. */
  retryLast: () => Promise<void>;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage?: string;
  summary: string;
  run: (args: string[], ctx: CommandContext) => Promise<boolean> | boolean;
}

const MODE_HELP: Record<PermissionMode, string> = {
  plan: "read-only, every mutation refused",
  pair: "asks clarifying questions before acting",
  ask: "prompt for writes and shell (default)",
  build: "writes auto-approved, shell still prompts",
  auto: "everything auto-approved except the deny-list",
  yolo: "everything auto-approved, deny-list included",
};

const EFFORT_HELP: Record<Effort, string> = {
  minimal: "fastest, least reasoning",
  low: "light reasoning",
  medium: "balanced",
  high: "deepest reasoning, slowest",
};

function modeBadge(mode: PermissionMode): string {
  const paint =
    mode === "plan"
      ? pc.blue
      : mode === "pair"
        ? pc.magenta
        : mode === "ask"
          ? pc.yellow
          : mode === "build"
          ? pc.cyan
          : mode === "auto"
            ? pc.green
            : pc.red;
  return paint(mode);
}

function requireMode(value: string): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    throw new Error(`Unknown mode "${value}". Use one of: ${PERMISSION_MODES.join(", ")}.`);
  }
  return value as PermissionMode;
}

function requireEffort(value: string): Effort {
  if (!EFFORTS.includes(value as Effort)) {
    throw new Error(`Unknown effort "${value}". Use one of: ${EFFORTS.join(", ")}.`);
  }
  return value as Effort;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * Opens the session browser. With an id it loads directly, so scripts and
 * `/resume <id>` keep working; without one it shows the navigable picker.
 */
async function browseSessions(ctx: CommandContext, id: string | undefined): Promise<void> {
  const entries = SessionStore.list();
  if (id !== undefined) {
    loadSession(ctx, id);
    return;
  }
  if (entries.length === 0) {
    printInfo("No sessions recorded yet.");
    return;
  }
  const here = ctx.runtime.config.cwd;
  const described = entries.map((entry) => {
    const messages = SessionStore.loadMessages(entry.id);
    const firstUser = messages.find((message) => message.role === "user");
    const opening = (firstUser?.content ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { entry, messages, opening, turns: messages.filter((m) => m.role === "user").length };
  });
  // Sessions with no messages cannot be resumed; only show them when there is
  // nothing else, so the list is not padded with rows that do nothing.
  const resumable = described.filter((row) => row.messages.length > 0);
  const shown = resumable.length > 0 ? resumable : described;
  const preferred = shown.find((row) => row.messages.length > 0)?.entry.id;
  const choice = await selectList({
    title: "Sessions",
    ...(preferred !== undefined ? { current: preferred } : {}),
    items: shown.map(({ entry, opening, turns }) => ({
      id: entry.id,
      label: entry.id,
      detail: `${entry.cwd === here ? pc.cyan("●") + " " : ""}${entry.updatedAt.slice(0, 19)}`,
      section: entry.cwd === here ? "this directory" : "elsewhere",
      preview: [
        `${turns} turn${turns === 1 ? "" : "s"} · ${entry.model}`,
        opening.length > 0 ? opening : "(no messages yet)",
      ],
    })),
  });
  if (choice === undefined) {
    printInfo("Selection cancelled.");
    return;
  }
  loadSession(ctx, choice.id);
}

function loadSession(ctx: CommandContext, id: string): void {
  const messages = SessionStore.loadMessages(id);
  if (messages.length === 0) {
    printError(`No messages found for session ${id}.`);
    return;
  }
  ctx.runtime.replaceHistory(messages);
  printInfo(`Loaded ${messages.length} messages from session ${id}.`);
}

async function listAndPickModels(ctx: CommandContext, filter: string): Promise<void> {
  const { runtime } = ctx;
  printInfo(`Fetching models from ${runtime.config.baseUrl ?? runtime.config.provider}…`);
  let models: ModelInfo[] = [];
  let live = true;
  try {
    models = await fetchModels(runtime.config);
  } catch (error) {
    live = false;
    printError(`${(error as Error).message}`);
  }
  if (models.length === 0) {
    // Offline or a rejected key: fall back to the models the registry knows,
    // so the picker still works and the user can correct a typo.
    models = knownModelsFor(runtime.config.provider, runtime.config.contextWindow);
    if (models.length === 0) {
      printInfo("The endpoint returned no models and none are known for this provider.");
      return;
    }
    printInfo(
      `Falling back to ${models.length} known model(s) for ${runtime.config.provider}. ` +
        pc.gray(live ? "" : "Set the key with /setup if the list looks wrong."),
    );
  }

  const choice = await selectModel(models, {
    current: runtime.config.model,
    ...(runtime.config.effort !== undefined ? { currentEffort: runtime.config.effort } : {}),
    ...(filter.length > 0 ? { filter } : {}),
  });

  if (choice === undefined) {
    if (process.stdin.isTTY === true) {
      printInfo("Selection cancelled.");
      return;
    }
    renderModelList(models, runtime.config.model, runtime.config.effort);
    printInfo("Pick one with /model <id> (or /models <filter> then /model <id>).");
    return;
  }

  runtime.setModel(choice.model);
  runtime.setEffort(choice.effort);
  printInfo(
    `Model set to ${pc.bold(choice.model)}` +
      (choice.effort !== undefined ? ` ${pc.gray("· effort")} ${pc.magenta(choice.effort)}` : ""),
  );
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "/help",
    summary: "Show this command reference",
    run: () => {
      printCommandHelp();
      return false;
    },
  },
  {
    name: "/models",
    usage: "/models [filter]",
    summary: "Browse models on the configured API and pick one",
    run: async (args, ctx) => {
      await listAndPickModels(ctx, args.join(" ").trim());
      return false;
    },
  },
  {
    name: "/model",
    usage: "/model [id]",
    summary: "Show or set the model directly",
    run: (args, ctx) => {
      const name = args.join(" ").trim();
      if (name.length === 0) {
        printInfo(`Current model: ${pc.bold(ctx.runtime.config.model)}`);
        return false;
      }
      ctx.runtime.setModel(name);
      printInfo(`Model set to ${pc.bold(name)}.`);
      return false;
    },
  },
  {
    name: "/effort",
    usage: "/effort [minimal|low|medium|high|off]",
    summary: "Show or set the reasoning effort",
    run: (args, ctx) => {
      const value = (args[0] ?? "").trim().toLowerCase();
      if (value.length === 0) {
        const current = ctx.runtime.config.effort;
        printInfo(`Reasoning effort: ${current ? pc.magenta(current) : pc.gray("off")}`);
        printInfo(EFFORTS.map((e) => `${pc.magenta(e)} ${pc.gray(EFFORT_HELP[e])}`).join("\n"));
        return false;
      }
      if (value === "off" || value === "none") {
        ctx.runtime.setEffort(undefined);
        printInfo("Reasoning effort disabled.");
        return false;
      }
      ctx.runtime.setEffort(requireEffort(value));
      printInfo(`Reasoning effort set to ${pc.magenta(value)}.`);
      return false;
    },
  },
  {
    name: "/mode",
    aliases: ["/permissions"],
    usage: "/mode [plan|ask|build|auto|yolo]",
    summary: "Show or set the permission mode",
    run: (args, ctx) => {
      const value = (args[0] ?? "").trim().toLowerCase();
      if (value.length === 0) {
        printPanel("Permission mode", [
          `active  ${modeBadge(ctx.runtime.config.mode)}  ${pc.gray(MODE_HELP[ctx.runtime.config.mode])}`,
          "",
          ...PERMISSION_MODES.map(
            (mode) =>
              `${mode === ctx.runtime.config.mode ? pc.cyan("▸") : " "} ${modeBadge(mode).padEnd(6)} ${pc.gray(MODE_HELP[mode])}`,
          ),
        ]);
        return false;
      }
      const mode = requireMode(value);
      ctx.runtime.setMode(mode);
      printInfo(`Permission mode set to ${modeBadge(mode)} ${pc.gray(MODE_HELP[mode])}`);
      return false;
    },
  },
  {
    name: "/status",
    aliases: ["/context"],
    summary: "Show model, mode, effort, context usage and cost",
    run: (_args, ctx) => {
      const { runtime } = ctx;
      const snapshot = runtime.cost.snapshot();
      const cost = snapshot.priced
        ? `$${snapshot.usd.toFixed(4)}`
        : pc.gray("free / unpriced");
      printPanel("Session status", [
        `provider   ${runtime.config.provider}`,
        `model      ${pc.bold(runtime.config.model)}`,
        `effort     ${runtime.config.effort ? pc.magenta(runtime.config.effort) : pc.gray("off")}`,
        `mode       ${modeBadge(runtime.config.mode)}`,
        `session    ${pc.gray(runtime.session.id)}`,
        `cwd        ${pc.gray(runtime.config.cwd)}`,
        `context    ${runtime.contextReport()}`,
        `cost       ${cost}`,
      ]);
      return false;
    },
  },
  {
    name: "/cost",
    summary: "Show token usage and spend",
    run: (_args, ctx) => {
      printInfo(ctx.runtime.cost.format());
      return false;
    },
  },
  {
    name: "/undo",
    usage: "/undo [n]",
    summary: "Revert the last agent file edit(s) from a snapshot",
    run: (args, ctx) => {
      const store = ctx.runtime.backups;
      const entries = store.list();
      if (entries.length === 0) {
        printInfo("No edits to undo in this session.");
        return false;
      }
      const count = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1);
      const last = entries.slice(-count);
      for (const entry of last.reverse()) {
        printInfo(store.restore(entry));
      }
      return false;
    },
  },
  {
    name: "/skills",
    usage: "/skills [list|search <q>|show <name>|review|new <name>]",
    summary: "List, inspect and review the reusable skills",
    run: (args, ctx) => {
      const registry = ctx.runtime.skills;
      const sub = args[0] ?? "list";

      if (sub === "search") {
        const query = args.slice(1).join(" ");
        if (query.length === 0) {
          printError("Usage: /skills search <query>");
          return false;
        }
        const hits = registry.search(query, 8);
        if (hits.length === 0) {
          printInfo(`No skill matches "${query}".`);
          return false;
        }
        printPanel(
          `Skills matching "${query}"`,
          hits.map((hit) => `${pc.bold(hit.skill.name)} ${pc.gray(`(${hit.score})`)} — ${hit.skill.description}`),
        );
        return false;
      }

      if (sub === "show") {
        const name = args[1];
        if (name === undefined) {
          printError("Usage: /skills show <name>");
          return false;
        }
        const skill = registry.get(name);
        if (skill === undefined) {
          printError(`Unknown skill "${name}".`);
          return false;
        }
        printPanel(`Skill · ${skill.name}`, [
          `source     ${skill.source}`,
          `version    ${skill.version ?? 1}`,
          `tags       ${skill.tags.join(", ") || pc.gray("none")}`,
          `path       ${skill.path}`,
        ]);
        process.stderr.write(`\n${skill.body}\n\n`);
        return false;
      }

      if (sub === "review") {
        const queue = registry.reviewQueue();
        if (queue.length === 0) {
          printInfo("Every skill has been used and none are flagged.");
          return false;
        }
        printPanel(
          "Skill review queue",
          queue.slice(0, 20).map((entry) => `${pc.yellow("·")} ${pc.bold(entry.name)} — ${entry.reason}`),
        );
        printInfo("Ask the agent to rewrite a flagged skill, or edit it in place.");
        return false;
      }

      if (sub === "new") {
        const name = args[1];
        if (name === undefined) {
          printError("Usage: /skills new <name>");
          return false;
        }
        const path = SkillLoader.write(
          ctx.runtime.config.cwd,
          name,
          `---\nname: ${name}\ndescription: Describe when this skill applies.\nversion: 1\ntags: []\n---\n\n# ${name}\n\nWrite the procedure here.\n`,
        );
        printInfo(`Created ${pc.bold(path)}. Edit it, then run /skills list.`);
        return false;
      }

      const skills = registry.skills;
      if (skills.length === 0) {
        printInfo("No skills found. Add one under .agents/skills/<name>/SKILL.md.");
        return false;
      }
      const bySource = { builtin: 0, user: 0, project: 0 };
      for (const skill of skills) bySource[skill.source] += 1;
      printPanel(
        `Skills (${skills.length}) · builtin ${bySource.builtin} · user ${bySource.user} · project ${bySource.project}`,
        skills.map((skill) => {
          const tag = skill.source === "project" ? pc.green("P") : skill.source === "user" ? pc.cyan("U") : pc.gray("B");
          const used = registry.usageFor(skill.name);
          const hint = used?.needsWork === true ? pc.yellow(" needs work") : used ? pc.gray(` ×${used.uses}`) : "";
          return `${tag} ${pc.bold(skill.name)} — ${skill.description}${hint}`;
        }),
      );
      printInfo("Use /skills show <name> to read one, or /skills review to see what needs attention.");
      return false;
    },
  },
  {
    name: "/todo",
    usage: "/todo [clear]",
    summary: "Show the agent's current task plan",
    run: (args, ctx) => {
      const items = ctx.runtime.todos();
      if (args[0] === "clear") {
        ctx.runtime.clearTodos();
        printInfo("Plan cleared.");
        return false;
      }
      if (items.length === 0) {
        printInfo("No plan yet. The agent records one with todo_write on multi-step tasks.");
        return false;
      }
      const marks: Record<string, string> = { pending: pc.gray("☐"), in_progress: pc.yellow("▶"), done: pc.green("☑") };
      printPanel(
        "Plan",
        items.map((todo) => `${marks[todo.status] ?? "☐"} ${todo.title}`),
      );
      return false;
    },
  },
  {
    name: "/files",
    summary: "List files the agent has modified this session",
    run: (_args, ctx) => {
      const entries = ctx.runtime.backups.list();
      if (entries.length === 0) {
        printInfo("The agent has not modified any files yet.");
        return false;
      }
      const seen = new Map<string, number>();
      for (const entry of entries) seen.set(entry.path, (seen.get(entry.path) ?? 0) + 1);
      const rows = [...seen.entries()].map(
        ([path, count]) => `${pc.cyan(String(count).padStart(2))}× ${path}`,
      );
      printPanel("Modified files", rows);
      printInfo("Use /undo to revert the most recent edit.");
      return false;
    },
  },
  {
    name: "/agent",
    usage: "/agent <goal>",
    summary: "Run an isolated sub-agent and print its conclusion",
    run: async (args, ctx) => {
      const goal = args.join(" ").trim();
      if (goal.length === 0) {
        printInfo("Usage: /agent <self-contained goal for a read-only sub-agent>");
        return false;
      }
      printInfo("Running isolated sub-agent…");
      try {
        const report = await ctx.runtime.subAgent.run(goal);
        process.stdout.write(`${report}\n`);
      } catch (error) {
        printError((error as Error).message);
      }
      return false;
    },
  },
  {
    name: "/tools",
    summary: "List the tools the agent can call",
    run: (_args, ctx) => {
      const rows = ctx.runtime.registry.list().map((tool) => {
        const kind = tool.category ?? (tool.readOnly ? "read" : "write");
        return `${pc.cyan(kind.padEnd(5))} ${tool.name.padEnd(16)} ${pc.gray(tool.description.slice(0, 64))}`;
      });
      printPanel("Tools", rows);
      return false;
    },
  },
  {
    name: "/diff",
    summary: "Show the working-tree diff",
    run: (_args, ctx) => {
      const stat = git(["diff", "--stat"], ctx.runtime.config.cwd);
      const full = git(["diff"], ctx.runtime.config.cwd);
      const staged = git(["diff", "--cached", "--stat"], ctx.runtime.config.cwd);
      if (stat === undefined) {
        printError("Not a git repository (or git is unavailable).");
        return false;
      }
      if (stat.trim().length === 0 && (staged ?? "").trim().length === 0) {
        printInfo("Working tree clean.");
        return false;
      }
      process.stdout.write(stat);
      if ((staged ?? "").trim().length > 0) process.stdout.write(pc.gray(`staged:\n${staged}`));
      if (full !== undefined && full.length > 0) process.stdout.write(full);
      return false;
    },
  },
  {
    name: "/sessions",
    aliases: ["/history"],
    usage: "/sessions [id]",
    summary: "Browse past sessions and open one",
    run: async (args, ctx) => {
      await browseSessions(ctx, args[0]);
      return false;
    },
  },
  {
    name: "/resume",
    usage: "/resume [id]",
    summary: "Open a previous session, interactively or by id",
    run: async (args, ctx) => {
      await browseSessions(ctx, args[0]);
      return false;
    },
  },
  {
    name: "/clear",
    summary: "Clear the conversation history",
    run: (_args, ctx) => {
      ctx.runtime.resetHistory();
      printInfo("Conversation cleared (session file kept for audit).");
      return false;
    },
  },
  {
    name: "/compact",
    summary: "Summarise earlier turns into a checkpoint",
    run: async (_args, ctx) => {
      const compaction = await ctx.runtime.compactNow();
      printInfo(
        compaction ? "Compacted earlier turns into a checkpoint." : "Nothing to compact yet.",
      );
      return false;
    },
  },
  {
    name: "/retry",
    summary: "Re-run the previous request",
    run: async (_args, ctx) => {
      await ctx.retryLast();
      return false;
    },
  },  {
    name: "/config",
    summary: "Show the effective configuration",
    run: (_args, ctx) => {
      const config = ctx.runtime.config;
      printPanel("Configuration", [
        `provider     ${config.provider}`,
        `family       ${specFor(config.provider)?.family ?? "custom"}`,
        `baseUrl      ${pc.gray(config.baseUrl ?? "(default)")}`,
        `model        ${config.model}`,
        `effort       ${config.effort ?? "off"}`,
        `mode         ${config.mode}`,
        `maxSteps     ${config.maxSteps}`,
        `maxTokens    ${config.maxTokens}`,
        `contextWindow ${config.contextWindow.toLocaleString()}`,
        `apiKeyEnv    ${config.apiKeyEnv}${config.apiKey ? pc.gray(" (+ apiKey in file)") : ""}`,
        `allow        ${config.permissions.allow.length} pattern(s)`,
        `deny         ${config.permissions.deny.length} pattern(s)`,
        `mcpServers   ${Object.keys(config.mcpServers).length}`,
        `workspace    ${config.allowOutsideWorkspace ? pc.yellow("tools may leave the workspace") : "tools are confined to cwd"}`,
      ]);
      return false;
    },
  },
  {
    name: "/setup",
    aliases: ["/configure"],
    usage: "/setup",
    summary: "Re-run the provider, credential and model wizard",
    run: async (_args, ctx) => {
      const result = await runOnboarding({
        defaultProvider: ctx.runtime.config.provider,
        defaultModel: ctx.runtime.config.model,
      });
      if (result.cancelled) {
        printInfo("Setup cancelled; the previous configuration is unchanged.");
        return false;
      }
      const fresh = loadConfig({}, ctx.runtime.config.cwd);
      ctx.runtime.config.provider = fresh.provider;
      ctx.runtime.config.model = fresh.model;
      ctx.runtime.config.apiKeyEnv = fresh.apiKeyEnv;
      if (fresh.baseUrl !== undefined) ctx.runtime.config.baseUrl = fresh.baseUrl;
      if (fresh.apiKey !== undefined) ctx.runtime.config.apiKey = fresh.apiKey;
      if (fresh.effort !== undefined) ctx.runtime.config.effort = fresh.effort;
      ctx.runtime.config.contextWindow = fresh.contextWindow;
      ctx.runtime.setModel(fresh.model);
      ctx.runtime.cost.setModel(fresh.model);
      ctx.runtime.rebuildProvider();
      printInfo(
        `Now using ${pc.bold(fresh.provider)} ${pc.gray("·")} ${pc.bold(fresh.model)}. ` +
          pc.gray("The next turn uses the new provider."),
      );
      return false;
    },
  },
  {
    name: "/providers",
    aliases: ["/provider"],
    usage: "/providers",
    summary: "List every bundled provider and its credential variable",
    run: (_args, _ctx) => {
      process.stdout.write(formatProviderTable());
      return false;
    },
  },
  {
    name: "/doctor",
    summary: "Diagnose environment, credentials and connectivity",
    run: async (_args, ctx) => {
      printPanel("Doctor", await collectDoctorRows(ctx.runtime.config));
      return false;
    },
  },
  {
    name: "/init",
    summary: "Write .carlsrc.json and CARLS.md into this project",
    run: (_args, ctx) => {
      const config = ctx.runtime.config;
      const configPath = join(config.cwd, ".carlsrc.json");
      const memoryPath = join(config.cwd, "CARLS.md");
      if (existsSync(configPath)) {
        printInfo(`${pc.bold(".carlsrc.json")} already exists; leaving it untouched.`);
      } else {
        const payload = {
          provider: config.provider,
          ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
          model: config.model,
          ...(config.effort !== undefined ? { effort: config.effort } : {}),
          mode: config.mode,
          apiKeyEnv: config.apiKeyEnv,
          maxSteps: config.maxSteps,
          maxTokens: config.maxTokens,
          permissions: config.permissions,
        };
        writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        printInfo(`Wrote ${pc.bold(configPath)}.`);
      }
      if (existsSync(memoryPath)) {
        printInfo(`${pc.bold("CARLS.md")} already exists; leaving it untouched.`);
      } else {
        writeFileSync(
          memoryPath,
          [
            "# Project instructions for carls-code",
            "",
            "Describe the conventions the agent must follow: build and test commands,",
            "code style, files it should never touch, and any domain rules.",
            "",
            "## Commands",
            "- build:",
            "- test:",
            "- lint:",
            "",
          ].join("\n"),
          "utf8",
        );
        printInfo(`Wrote ${pc.bold(memoryPath)}.`);
      }
      return false;
    },
  },
  {
    name: "/theme",
    usage: "/theme [dark|light]",
    summary: "Show or switch the colour theme",
    run: (args, _ctx) => {
      const requested = (args[0] ?? "").trim().toLowerCase();
      if (requested.length === 0) {
        printInfo(`Theme: ${pc.bold(theme().name)} (set with /theme dark or /theme light).`);
        return false;
      }
      if (requested !== "dark" && requested !== "light") {
        printError("Theme must be dark or light.");
        return false;
      }
      refreshTheme(requested);
      printInfo(`Theme set to ${pc.bold(requested)}.`);
      return false;
    },
  },
  {
    name: "/exit",
    aliases: ["/quit"],
    summary: "Leave the REPL",
    run: () => true,
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((cmd) => cmd.name === name || (cmd.aliases ?? []).includes(name));
}

export function printCommandHelp(): void {
  const rows = COMMANDS.map((cmd) => {
    const label = `${cmd.name}${cmd.usage ? pc.gray(cmd.usage.slice(cmd.name.length)) : ""}`;
    return `${label.padEnd(34)} ${pc.gray(cmd.summary)}`;
  });
  printPanel("Commands", [
    ...rows,
    "",
    `${"/ or Ctrl+P".padEnd(34)} ${pc.gray("open the filterable command palette")}`,
    `${"!<command>".padEnd(34)} ${pc.gray("run a shell command in the workspace")}`,
    `${"# note".padEnd(34)} ${pc.gray("added to the session context")}`,
    `${"Shift+Tab".padEnd(34)} ${pc.gray("cycle the permission mode")}`,
  ]);
}

/** Dispatches a slash command. Returns true when the REPL should exit. */
export async function runCommand(input: string, ctx: CommandContext): Promise<boolean> {
  const [name, ...args] = input.split(/\s+/);
  const command = name === undefined ? undefined : findCommand(name);
  if (!command) {
    printError(`Unknown command ${name ?? ""}. Try ${pc.bold("/help")}.`);
    return false;
  }
  try {
    return await command.run(args, ctx);
  } catch (error) {
    printError((error as Error).message);
    return false;
  }
}

/** Runs a `!command` passthrough in the workspace directory. */
export function runShellPassthrough(command: string, cwd: string): void {
  try {
    const output = execFileSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    process.stdout.write(output);
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    printError(err.message.split("\n")[0] || "command failed");
  }
}
