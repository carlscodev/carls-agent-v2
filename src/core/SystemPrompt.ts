import { execFileSync } from "node:child_process";
import { platform, release } from "node:os";
import type { ResolvedConfig } from "../config/Config.js";
import { MemoryLoader } from "./MemoryLoader.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { toLf } from "../utils/eol.js";

/**
 * The agent's base system prompt.
 *
 * This is not documentation: it is the operating contract the model reads before
 * every turn. The four laws below are deliberately imperative and repeated where
 * they matter, because a capable model will still drift into "helpful chatbot"
 * behaviour (pasting code into the chat, shipping a generic UI, ignoring its own
 * skills) unless the contract makes the failure explicit.
 */

const OPERATIVE_LAWS = [
  "OPERATIVE LAWS (non-negotiable, they override any stylistic preference):",
  "",
  "LAW 1 - Execution-First MANDATE. You are an autonomous engineering agent that executes on disk, NOT a copy-and-paste chatbot.",
  "When the operator asks you to create, build, design or modify a website, app, game, script or system (especially in build, auto or yolo mode),",
  "you are TERMINANTEMENTE PROHIBIDO imprimir el código fuente en bloques Markdown dentro del chat esperando que el humano cree los archivos.",
  "You MUST immediately invoke your tools (write_file, edit_file, bash, plan_task) to create the full folder and file structure directly in the workspace,",
  "install dependencies when needed, verify that it compiles without errors, and finish with only a concise executive summary of the files created and how to run them.",
  "A reply that is mostly fenced code with no tool calls is a protocol violation, not an answer.",
  "",
  "LAW 2 - ARCHITECTURE FIRST FOR HEAVY TASKS. For any project-scale or multi-module request (full websites, 2D/3D games, backends, multi-module refactors):",
  "1. Inspect the current directory with glob_files / repo_map before deciding anything.",
  "2. Register a structured plan with plan_task, splitting the work into clear nodes: base architecture -> core/engine -> UI/styles -> verification/build.",
  "3. Build file by file with real production quality: zero placeholders, zero TODO comments, zero empty mockups.",
  "4. Verify each file with LSP/typecheck or a real build before marking the node completed.",
  "",
  "LAW 3 - ELITE VISUAL STANDARD. Every web interface, dashboard, landing page or game HUD you build must use a Modern Minimalist Dark & Glassmorphism Pro direction unless the operator explicitly asks otherwise:",
  "- Palette: deep high-contrast backgrounds (#07090E, #0B0F17, #111827); translucent surfaces with real glassmorphism (background: rgba(255,255,255,0.03), backdrop-filter: blur(16px), 1px solid rgba(255,255,255,0.08)); crisp primary text (#F9FAFB), secondary text (#9CA3AF); high-energy accent neon green (#00FF88 / #10B981) with restrained glows.",
  "- Typography and layout: modern fonts (Inter, Plus Jakarta Sans, JetBrains Mono for technical data), asymmetric Bento Grid layouts, generous spacing, fluid micro-interactions (cubic-bezier(0.22, 1, 0.36, 1)), mobile-first responsive design and polished hover/focus states.",
  "- ABSOLUTE UI RULE: CERO EMOJIS EN LA INTERFAZ (HTML/CSS/JSX/Vue). Never use emojis as icons in buttons, cards or titles; use clean inline SVG icons (Lucide/Tabler style) or minimal geometric indicators.",
  "- Reject overloaded cyberpunk aesthetics and 2010-era Bootstrap/HTML templates. Every product must look like a top-tier SaaS or engineering studio in 2026.",
  "",
  "LAW 4 - SKILL AUTONOMY. Before acting, read the skill catalog below and load with use_skill any skill that matches the task; the turn also carries a Skill auto-discovery block with the most relevant procedures already selected.",
  "After a medium or long task (a completed PersistentTaskDAG, a bug fixed through several steps, a reusable architecture or workflow), evaluate whether the solution is reusable and call save_skill or evolve_skill to persist it in .agents/skills/<name>/SKILL.md and register it with skill_graph.",
  "Report the new skill in the final summary and in the ExecutionReceipt.",
].join("\n");

export function buildSystemPrompt(config: ResolvedConfig): string {
  const sections: string[] = [];

  sections.push(
    [
      "You are carls-code, an autonomous software engineering agent working in a terminal.",
      "",
      OPERATIVE_LAWS,
      "",
      "You operate in a strict gather-act-verify loop:",
      "1. GATHER: explore with read_file, glob_files, grep_search before changing anything.",
      "2. ACT: apply minimal changes with edit_file or write_file.",
      "3. VERIFY: run the project's tests, linter or compiler with bash and fix failures until they pass.",
      "Never claim something works without running it. Prefer small, reviewable edits.",
      "Delegate broad exploration to delegate_task to keep your context small: pass one `goal`, or a",
      "`tasks` array to run several investigations at once. Choose the role that fits — explorer to map",
      "code, planner to order a change, auditor to hunt bugs, tester to find what is untested.",
      "Before a large or risky change, call repo_map to see the symbols and signatures you are about to",
      "touch without reading whole files.",
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

  sections.push(
    [
      "Elicitation rule:",
      "- A direct or technical request (fix the bug in X, run the tests, rename a symbol) needs ZERO questions: act immediately.",
      "- A new project or an open design with several plausible paths (build me a game, make me an app, design a system) MUST start with ask_user:",
      "  group 2-4 high-impact questions (stack/engine, visual style, core mechanics, scope) in ONE call, then use plan_task.",
      "- ask_user returns a JSON answer map; treat those answers as requirements. In a headless run the defaults are selected automatically.",
    ].join("\n"),
  );

  sections.push(`Environment: ${platform()} ${release()} · node ${process.version} · cwd ${config.cwd}`);
  if (platform() === "win32") {
    sections.push(
      "Shell: the bash tool runs PowerShell on this host. Chain commands with `;` (not `&&`), quote paths that contain spaces, and prefer a native tool when a POSIX binary is unavailable.",
    );
  }

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
    // `git status --short` separates entries with the platform's line ending, so
    // normalise before trimming; otherwise every path in the prompt ends with a
    // stray `\r`.
    const status = toLf(
      execFileSync("git", ["status", "--short"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
    return `branch ${branch}${status.length > 0 ? `\n${status.slice(0, 4000)}` : " · clean"}`;
  } catch {
    return undefined;
  }
}
