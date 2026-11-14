/**
 * Dual-speed intent router.
 *
 * A coding agent that treats "hola" and "build me a 3D browser game" the same way
 * is bad at both: the greeting pays for a disk pre-scan and a skill catalog it
 * does not need, and the game gets the same thin prompt as small talk. This
 * router classifies a goal in well under a millisecond — no LLM call, no I/O — so
 * the loop can pick a light prompt for conversation and the full architect
 * treatment for real engineering work.
 *
 * The classification is deliberately lexical. A model round-trip to decide
 * whether the user said hello would cost more than the whole fast-path turn.
 */

export type IntentProfile = "CONVERSATIONAL_FAST_PATH" | "DIRECT_CODE_TASK" | "HEAVY_ARCHITECT_POWER_MODE";

export type ExpertRole =
  | "Web Developer / UI Architect"
  | "3D/2D Browser Game Architect"
  | "Full-Stack / Backend Engineer"
  | "Security / Reliability Auditor"
  | "DevOps / Cloud Infrastructure Architect"
  | "Systems Architect";

export interface IntentDecision {
  profile: IntentProfile;
  /** Domain detected from the goal, or undefined for a plain conversation. */
  role?: ExpertRole;
  /** Skill names the domain should force into the prompt, best first. */
  skillHints: string[];
  /** Why the router decided this, for the thought telemetry line. */
  reason: string;
}

/** Normalises accents and case so the lexical rules match "creá" and "crea". */
export function normalizeGoal(goal: string): string {
  return goal
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Whole-utterance greetings. Anchored so "hey, arregla el bug de login" is a
 * code task and not small talk: only a bare greeting counts.
 */
const GREETING =
  /^(hola|hey|hi|hello|buenas|buenos dias|buenas tardes|buenas noches|que tal|que onda|saludos|gracias|muchas gracias|thanks|thank you|ok|okay|vale|perfecto|genial|cool|entendido|de acuerdo)[.!¡¿?\s]*$/;

const GRATITUDE = /\b(gracias|thanks|thank you|genial|perfecto|excelente|muy bien)\b/;

/** Short conceptual questions that want an answer, not a project. */
const CONCEPTUAL =
  /\b(que es|que son|como funciona|explicame|explica|diferencia entre|para que sirve|por que|cuando usar)\b/;

/** Verbs and nouns that mean "engineer this", not "chat about this". */
const HEAVY_INTENT =
  /\b(crea\w*|constru\w*|haz\w*|hacer|build|create|make|genera\w*|desarrolla\w*|implementa\w*|refactoriza\w*|refactor|arquitectura|architecture|scaffold|monta\w*|levanta\w*|disena\w*|design)\b/;

const HEAVY_ARTIFACT =
  /\b(web|website|pagina|page|landing|dashboard|panel|app|aplicacion|application|sistema|system|juego|game|videojuego|api|backend|frontend|fullstack|full-stack|servicio|service|plataforma|platform|crud|admin|portfolio|portafolio|tienda|shop|ecommerce|e-commerce|blog|3d|2d|motor|engine|cli|herramienta|tool|bot|scraper|parser|compilador|compiler|interprete|runtime|framework|libreria|library)\b/;

/** Direct, single-file or single-command work. */
const DIRECT_INTENT =
  /\b(arregla\w*|corrige\w*|fix|soluciona\w*|repara\w*|cambia\w*|modifica\w*|actualiza\w*|renombra\w*|elimina\w*|borra\w*|mueve\w*|anade\w*|agrega\w*|quita\w*|ejecuta\w*|corre\w*|lanza\w*|run|test|tests|pruebas|lint|typecheck|build|compila\w*|instala\w*|install)\b/;

const GAME_HINT =
  /\b(juego|game|videojuego|3d|2d|three\.?js|babylon|webgl|canvas|shader|sprite|arcade|plataformas|platformer|fps|rpg|godot|unity|pixel)\b/;
const WEB_HINT =
  /\b(web|website|pagina|landing|dashboard|panel|frontend|ui|ux|css|tailwind|react|vue|svelte|astro|html|portafolio|portfolio|glassmorphism|animacion|responsive|tienda|shop|bento)\b/;
const BACKEND_HINT =
  /\b(api|backend|servidor|server|base de datos|database|sql|postgres|sqlite|mysql|mongo|rest|graphql|endpoint|microservicio|microservice|auth|autenticacion|fullstack|full-stack|crud|cola|queue|worker|cache|webhook|grpc)\b/;
const SECURITY_HINT =
  /\b(seguridad|security|vulnerabilidad\w*|vulnerability|pentest\w*|auditoria|hardening|endurec\w*|exploit|xss|csrf|sqli|inyeccion|injection|criptografia|owasp|secret\w*)\b/;
const DEVOPS_HINT =
  /\b(docker|dockerfile|kubernetes|k8s|helm|ci\/cd|cicd|github actions|gitlab ci|deploy\w*|desplieg\w*|contenedor\w*|container\w*|infraestructura|infrastructure|terraform|nginx)\b/;
const SYSTEMS_HINT =
  /\b(sistema|system|compilador|compiler|interprete|runtime|kernel|driver|daemon|concurrencia|concurrency|memoria|memory|performance|rendimiento|optimiza\w*|cli|tui|terminal|parser|scraper|protocolo|protocol|socket|thread|proceso|process|vm|bytecode|linux|bash|shell|agente|agent)\b/;

/** Skill names the router prefers per role, matching real builtin skills first. */
const ROLE_SKILL_HINTS: Record<ExpertRole, string[]> = {
  "Web Developer / UI Architect": [
    "modern-web-glassmorphism",
    "design-no-generic-ui",
    "frontend-web",
    "autonomous-project-scaffold",
  ],
  "3D/2D Browser Game Architect": [
    "tactical-3d-web-game",
    "autonomous-project-scaffold",
    "performance",
  ],
  "Full-Stack / Backend Engineer": [
    "api-design",
    "sql-databases",
    "security-review",
    "autonomous-project-scaffold",
  ],
  "Security / Reliability Auditor": [
    "security-review",
    "testing-strategy",
    "anti-generic-code",
  ],
  "DevOps / Cloud Infrastructure Architect": [
    "docker-containers",
    "kubernetes",
    "ci-cd",
    "shell-bash",
  ],
  "Systems Architect": [
    "anti-generic-code",
    "autonomous-project-scaffold",
    "performance",
    "testing-strategy",
  ],
};

/** Picks the expert role from the domain keywords, most specific first. */
export function detectRole(goal: string): ExpertRole | undefined {
  const text = normalizeGoal(goal);
  if (GAME_HINT.test(text)) return "3D/2D Browser Game Architect";
  if (DEVOPS_HINT.test(text)) return "DevOps / Cloud Infrastructure Architect";
  if (BACKEND_HINT.test(text)) return "Full-Stack / Backend Engineer";
  if (WEB_HINT.test(text)) return "Web Developer / UI Architect";
  if (SECURITY_HINT.test(text)) return "Security / Reliability Auditor";
  if (SYSTEMS_HINT.test(text)) return "Systems Architect";
  return undefined;
}

/**
 * Classifies a goal. Order matters: a bare greeting is a fast path even though it
 * is short, and a greeting that also names an artifact ("hola, hazme una web") is
 * power mode because the artifact rule is checked before the conversational one.
 */
export function routeIntent(goal: string): IntentDecision {
  const text = normalizeGoal(goal);
  if (text.length === 0) {
    return { profile: "CONVERSATIONAL_FAST_PATH", skillHints: [], reason: "empty input" };
  }

  const role = detectRole(goal);
  const heavyIntent = HEAVY_INTENT.test(text);
  const heavyArtifact = HEAVY_ARTIFACT.test(text);

  // Power mode: an explicit build verb plus an artifact, or a named artifact with
  // a role, or a creation verb the artifact list does not name (a bespoke system).
  if ((heavyIntent && heavyArtifact) || (role !== undefined && heavyIntent)) {
    const detected = role ?? "Systems Architect";
    return {
      profile: "HEAVY_ARCHITECT_POWER_MODE",
      role: detected,
      skillHints: ROLE_SKILL_HINTS[detected],
      reason: `build verb + artifact -> ${detected}`,
    };
  }

  // A bare greeting, thanks or a one-line confirmation is a fast path.
  if (GREETING.test(text) || (text.length <= 24 && GRATITUDE.test(text) && !heavyIntent)) {
    return { profile: "CONVERSATIONAL_FAST_PATH", skillHints: [], reason: "greeting or acknowledgement" };
  }

  // A short conceptual question wants an explanation, not a project.
  if (CONCEPTUAL.test(text) && text.length <= 200) {
    return { profile: "CONVERSATIONAL_FAST_PATH", skillHints: [], reason: "conceptual question" };
  }

  // Anything that names an artifact but no build verb is still heavy: "necesito
  // un dashboard para ventas" is a project even without "crea".
  if (heavyArtifact && text.length >= 12) {
    const detected = role ?? "Systems Architect";
    return {
      profile: "HEAVY_ARCHITECT_POWER_MODE",
      role: detected,
      skillHints: ROLE_SKILL_HINTS[detected],
      reason: `artifact named -> ${detected}`,
    };
  }

  if (DIRECT_INTENT.test(text) || heavyIntent) {
    return {
      profile: "DIRECT_CODE_TASK",
      ...(role !== undefined ? { role } : {}),
      skillHints: role !== undefined ? ROLE_SKILL_HINTS[role] : [],
      reason: "direct edit or command",
    };
  }

  // A very short utterance with no code signal is conversation; anything longer
  // that we could not classify gets the lightest code treatment rather than a
  // heavy scaffold it may not need.
  if (text.length <= 40) {
    return { profile: "CONVERSATIONAL_FAST_PATH", skillHints: [], reason: "short utterance" };
  }
  return { profile: "DIRECT_CODE_TASK", skillHints: [], reason: "unclassified, treated as direct work" };
}

/** True when the profile should skip disk pre-scan, DAG and heavy skills. */
export function isFastPath(decision: IntentDecision): boolean {
  return decision.profile === "CONVERSATIONAL_FAST_PATH";
}
