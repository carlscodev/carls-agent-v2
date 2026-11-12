import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { globbySync } from "globby";
import { charsForTokens, estimateTokens } from "../utils/tokens.js";

/**
 * A repository symbol map, built without an AST dependency.
 *
 * The point is not fidelity, it is cost: reading five whole files to answer
 * "where is `guardPath`?" burns the context window that the actual change needs.
 * A signature index answers the same question in a few hundred tokens, and the
 * agent reads the full file only once it has decided the file matters.
 *
 * Signatures are extracted with anchored regular expressions plus a brace
 * counter for `interface` and `class` bodies. That is deliberately approximate:
 * a missed declaration costs one extra `read_file`, while a bundled parser would
 * cost the dependency-free build.
 */

export type SymbolKind =
  | "class"
  | "interface"
  | "type"
  | "function"
  | "const"
  | "enum"
  | "method";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  /** Workspace-relative, forward-slashed for stable display on Windows. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  /** The declaration line, whitespace-collapsed and length-capped. */
  signature: string;
  exported: boolean;
  /** Members of an interface/class, or the enum members. Capped. */
  members?: string[];
}

export interface FileIndex {
  file: string;
  symbols: SymbolEntry[];
  /** Workspace-relative paths this file imports. */
  imports: string[];
  /** Lines in the file, so the map can say what reading it would cost. */
  lines: number;
}

export interface RepoMapOptions {
  /** Cap on files indexed, newest-agnostic; keeps a monorepo from hanging. */
  maxFiles?: number;
  /** Extra glob patterns to skip. */
  ignore?: string[];
}

const SOURCE_GLOBS = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,rs,rb,java}"];

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/out/**",
  "**/.next/**",
  "**/vendor/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/*.min.js",
  "**/*.d.ts",
];

/** Files beyond this are almost certainly generated; skip the parse. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_MEMBERS = 12;
const MAX_SIGNATURE_CHARS = 160;

const DECLARATIONS: ReadonlyArray<{ kind: SymbolKind; pattern: RegExp }> = [
  { kind: "class", pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", pattern: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: "enum", pattern: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "const", pattern: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
];

// Python, Go and Rust, so a polyglot workspace still gets a usable index.
const OTHER_LANGUAGE: ReadonlyArray<{ kind: SymbolKind; pattern: RegExp }> = [
  { kind: "class", pattern: /^class\s+([A-Za-z_]\w*)/ },
  { kind: "function", pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { kind: "function", pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { kind: "function", pattern: /^pub\s+fn\s+([A-Za-z_]\w*)/ },
  { kind: "function", pattern: /^fn\s+([A-Za-z_]\w*)/ },
];

const IMPORT_PATTERNS: readonly RegExp[] = [
  /^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/,
  /^\s*import\s+['"]([^'"]+)['"]/,
  /^\s*export\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/,
  /^\s*from\s+([.\w]+)\s+import/,
  /^\s*use\s+(crate|super|self)[\w:]*/,
];

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Collapses whitespace and caps length, so one long line cannot flood the map. */
function oneLine(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length > MAX_SIGNATURE_CHARS
    ? `${collapsed.slice(0, MAX_SIGNATURE_CHARS - 1)}…`
    : collapsed;
}

/**
 * Collects the declaration lines inside a braced body, stopping at the matching
 * close brace. Member lines are the ones that look like declarations; comments
 * and blank lines are dropped.
 */
function collectMembers(lines: readonly string[], startIndex: number): { members: string[]; endIndex: number } {
  const members: string[] = [];
  let depth = 0;
  let opened = false;
  let index = startIndex;

  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    // Depth at the start of the line: a member declaration sits directly inside
    // the body (depth 1), while a method's own statements sit at depth 2 and are
    // implementation, not interface.
    const depthAtStart = depth;
    for (const char of line) {
      if (char === "{") {
        depth++;
        opened = true;
      } else if (char === "}") {
        depth--;
      }
    }
    if (index > startIndex && depthAtStart === 1) {
      const trimmed = line.trim();
      const isMember =
        trimmed.length > 0 &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*") &&
        trimmed !== "}" &&
        trimmed !== "{";
      if (isMember && members.length < MAX_MEMBERS) members.push(oneLine(trimmed));
    }
    if (opened && depth <= 0) break;
    // A declaration with no body (e.g. `export type X = ...`) ends on its line.
    if (!opened && index > startIndex) break;
  }

  return { members, endIndex: index };
}

/**
 * Import specifiers resolved to a workspace-relative path without extension, so
 * `./paths.js` in `src/tools/` and `src/utils/paths.ts` compare equal. TypeScript
 * source imports the emitted `.js` name, which is why the extension is dropped.
 */
function importsOf(lines: readonly string[], from: string): string[] {
  const found: string[] = [];
  for (const line of lines) {
    for (const pattern of IMPORT_PATTERNS) {
      const match = line.match(pattern);
      if (!match?.[1]) continue;
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const base = toPosix(join(dirname(from), specifier)).replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, "");
      found.push(base);
      break;
    }
  }
  return found;
}

/** A workspace path without its extension, for comparing imports to files. */
function withoutExtension(path: string): string {
  return toPosix(path).replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, "");
}

/** Trims a block to a character budget, keeping whole lines where possible. */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  return `${lastNewline > 0 ? cut.slice(0, lastNewline) : cut}\n… (truncated)`;
}

/** Parses one file's source into declarations. Exported for direct testing. */
export function extractSymbols(source: string, file: string, isTypeScript: boolean): SymbolEntry[] {
  const lines = source.split(/\r?\n/);
  const symbols: SymbolEntry[] = [];
  const table = isTypeScript ? DECLARATIONS : [...DECLARATIONS, ...OTHER_LANGUAGE];

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) {
      continue;
    }
    // A member inside a class body is not a top-level declaration.
    if (/^\s/.test(raw) && isTypeScript) continue;

    for (const { kind, pattern } of table) {
      const match = line.match(pattern);
      const name = match?.[1];
      if (name === undefined) continue;

      const entry: SymbolEntry = {
        name,
        kind,
        file,
        line: index + 1,
        signature: oneLine(line),
        exported: /^export\b/.test(line),
      };

      if (kind === "interface" || kind === "class" || kind === "enum") {
        const { members } = collectMembers(lines, index);
        if (members.length > 0) entry.members = members;
      }

      symbols.push(entry);
      break;
    }
  }

  return symbols;
}

export interface RepoMapStats {
  files: number;
  symbols: number;
  /** Approximate tokens the full index would cost. */
  fullTokens: number;
  builtAt: number;
}

/**
 * The index itself. Built once per session (or refreshed on demand) and queried
 * by `repo_map`; nothing here mutates the workspace.
 */
export class RepoMap {
  private readonly files = new Map<string, FileIndex>();
  private readonly bySymbol = new Map<string, SymbolEntry[]>();
  private readonly importedBy = new Map<string, number>();
  private readonly root: string;
  private builtAt = 0;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get size(): number {
    return this.files.size;
  }

  isStale(maxAgeMs = 5 * 60 * 1000): boolean {
    return this.builtAt === 0 || Date.now() - this.builtAt > maxAgeMs;
  }

  stats(): RepoMapStats {
    let symbols = 0;
    let fullTokens = 0;
    for (const index of this.files.values()) {
      symbols += index.symbols.length;
      for (const symbol of index.symbols) fullTokens += estimateTokens(symbol.signature);
    }
    return { files: this.files.size, symbols, fullTokens, builtAt: this.builtAt };
  }

  /**
   * Scans the workspace. `globbySync` is used because the whole index is built
   * before the first model call and an async sweep would only add latency.
   */
  build(options: RepoMapOptions = {}): RepoMapStats {
    this.files.clear();
    this.bySymbol.clear();
    this.importedBy.clear();

    const maxFiles = options.maxFiles ?? 2000;
    const matches = globbySync(SOURCE_GLOBS, {
      cwd: this.root,
      ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
      dot: false,
      onlyFiles: true,
      gitignore: true,
      absolute: false,
    });

    for (const relativePath of matches.sort().slice(0, maxFiles)) {
      const file = toPosix(relativePath);
      const absolute = join(this.root, file);
      let source: string;
      try {
        source = readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      if (source.length > MAX_FILE_BYTES) continue;

      const isTypeScript = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file);
      const lines = source.split(/\r?\n/).length;
      const symbols = extractSymbols(source, file, isTypeScript);
      const imports = importsOf(source.split(/\r?\n/), file);

      this.files.set(file, { file, symbols, imports, lines });
      for (const symbol of symbols) {
        const bucket = this.bySymbol.get(symbol.name);
        if (bucket === undefined) this.bySymbol.set(symbol.name, [symbol]);
        else bucket.push(symbol);
      }
      for (const imported of imports) {
        const key = withoutExtension(imported);
        this.importedBy.set(key, (this.importedBy.get(key) ?? 0) + 1);
      }
    }

    this.builtAt = Date.now();
    return this.stats();
  }

  /** Exact-name lookup, case-insensitive, ranked by how central the file is. */
  find(query: string, limit = 20): SymbolEntry[] {
    const needle = query.toLowerCase();
    const exact = this.bySymbol.get(query) ?? [];
    const loose: SymbolEntry[] = [];

    if (exact.length === 0) {
      for (const [name, entries] of this.bySymbol) {
        if (name.toLowerCase().includes(needle)) loose.push(...entries);
      }
    }

    const candidates = exact.length > 0 ? exact : loose;
    return [...candidates]
      .sort((a, b) => this.rank(b) - this.rank(a) || a.file.localeCompare(b.file))
      .slice(0, limit);
  }

  /** Symbols declared in one file, in declaration order. */
  inFile(file: string): SymbolEntry[] {
    return this.files.get(toPosix(file))?.symbols ?? [];
  }

  /** Files that import `file`. Extension-insensitive, so `.js` specifiers match. */
  dependents(file: string): string[] {
    const target = withoutExtension(file);
    const out: string[] = [];
    for (const index of this.files.values()) {
      if (index.file === toPosix(file)) continue;
      if (index.imports.some((spec) => withoutExtension(spec) === target)) out.push(index.file);
    }
    return out.sort();
  }

  private rank(symbol: SymbolEntry): number {
    const central = this.importedBy.get(withoutExtension(symbol.file)) ?? 0;
    return central * 10 + (symbol.exported ? 3 : 0) + (symbol.members?.length ?? 0);
  }

  /** The most-referenced files first; ties break on path for stable output. */
  private rankedFiles(): FileIndex[] {
    return [...this.files.values()].sort((a, b) => {
      const byRank =
        (this.importedBy.get(withoutExtension(b.file)) ?? 0) -
        (this.importedBy.get(withoutExtension(a.file)) ?? 0);
      if (byRank !== 0) return byRank;
      return a.file.localeCompare(b.file);
    });
  }

  /**
   * Renders the index as a signature map, stopping at a token budget. Only
   * exported symbols are listed: they are the ones another file can call, which
   * is what a caller actually needs to see.
   *
   * The budget is hard. A single large file would otherwise overshoot it by its
   * whole body, and the caller picked the budget precisely to bound the prompt.
   */
  render(maxTokens = 2000, options: { onlyExported?: boolean } = {}): string {
    const onlyExported = options.onlyExported ?? true;
    const lines: string[] = [];
    let spent = 0;
    let filesShown = 0;
    let filesTotal = 0;

    for (const index of this.rankedFiles()) {
      const symbols = index.symbols.filter((symbol) => !onlyExported || symbol.exported);
      if (symbols.length === 0) continue;
      filesTotal++;

      const block = this.renderBlock(index, symbols);
      const cost = estimateTokens(block);

      if (spent + cost > maxTokens) {
        if (filesShown === 0) {
          // Nothing fits yet: show as much of the top file as the budget allows
          // rather than returning nothing at all.
          lines.push(clip(block, charsForTokens(Math.max(120, maxTokens))));
          spent = maxTokens;
          filesShown = 1;
        }
        break;
      }

      lines.push(block);
      spent += cost;
      filesShown++;
    }

    if (lines.length === 0) return "The repository map is empty.";
    const omitted = filesTotal - filesShown;
    if (omitted > 0) {
      lines.push(`… ${omitted} more file${omitted === 1 ? "" : "s"} indexed; ask for one by name.`);
    }
    return lines.join("\n\n");
  }

  private renderBlock(index: FileIndex, symbols: SymbolEntry[]): string {
    const body = symbols.map((symbol) => {
      const head = `  ${symbol.kind} ${symbol.name}  ·  ${symbol.signature.replace(/^export\s+/, "")}`;
      const members = symbol.members?.map((member) => `      ${member}`) ?? [];
      return [head, ...members].join("\n");
    });
    return `${index.file} (${index.lines} lines)\n${body.join("\n")}`;
  }

  /** A one-line-per-symbol view of a single file, for a targeted question. */
  renderFile(file: string): string {
    const index = this.files.get(toPosix(file));
    if (index === undefined) return `No indexed file matches "${file}".`;
    if (index.symbols.length === 0) {
      return `${index.file} (${index.lines} lines): no top-level declarations found.`;
    }
    const body = index.symbols.map((symbol) => {
      const members = symbol.members?.map((member) => `    ${member}`) ?? [];
      return [`${symbol.line}: ${symbol.signature}`, ...members].join("\n");
    });
    return `${index.file} (${index.lines} lines)\n${body.join("\n")}`;
  }
}
