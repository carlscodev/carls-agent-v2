import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";

/**
 * Web reading.
 *
 * `network_request` returns raw bytes, which is useless to a model asked a
 * question: it gets a wall of markup and burns context on it. These two tools do
 * the reading part — fetch and reduce a page to text, or search and return
 * titles, links and snippets — so gathering from the web costs one call.
 *
 * The search backend is DuckDuckGo's HTML endpoint because it needs no key: a
 * tool that only works after the user signs up somewhere is not a tool the agent
 * can rely on. `CARLS_SEARCH_ENDPOINT` points it at a mirror (and at a fixture
 * server in tests).
 */

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
/** Tried when the primary endpoint answers 429, 5xx or a challenge page. */
const FALLBACK_SEARCH_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_CHARS = 20_000;
const MAX_FETCH_CHARS = 200_000;
/** Nothing a page needs to say is bigger than this; reading more is a memory bug. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SEARCH_ATTEMPTS = 2;
const SEARCH_RETRY_DELAY_MS = 500;
const USER_AGENT = "carls-code/1.0 (+terminal coding agent)";
/** Tracking parameters that make the same result look like two results. */
const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|rut|ref_src|ref_url)$/i;

/**
 * Hosts a tool must not reach on its own initiative.
 *
 * A model reading a web page is exactly the situation where a prompt injection
 * asks for `http://169.254.169.254/latest/meta-data/` or the admin panel on
 * localhost. `CARLS_ALLOW_LOCAL_FETCH=1` is the escape hatch for development
 * against a local server.
 */
export function localHostReason(hostname: string): string | undefined {
  if (process.env.CARLS_ALLOW_LOCAL_FETCH === "1") return undefined;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return "empty host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "loopback or private host";
  }
  if (host === "::1" || host === "::" || /^(fc|fd|fe80)[0-9a-f:]*$/.test(host)) {
    return "private IPv6 address";
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 0 || first === 10 || first === 127) return "loopback or private address";
    // Link-local, which is where cloud metadata lives.
    if (first === 169 && second === 254) return "link-local address (cloud metadata)";
    if (first === 172 && second >= 16 && second <= 31) return "private address";
    if (first === 192 && second === 168) return "private address";
    if (first === 100 && second >= 64 && second <= 127) return "carrier-grade NAT address";
  }
  return undefined;
}

/** Rejects a URL the tools refuse to fetch, with the reason. */
export function urlProblem(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "not an absolute URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `protocol ${parsed.protocol} is not allowed (http and https only)`;
  }
  const local = localHostReason(parsed.hostname);
  if (local !== undefined) {
    return `${local}; set CARLS_ALLOW_LOCAL_FETCH=1 to allow it deliberately`;
  }
  return undefined;
}

/** Reads at most `MAX_BODY_BYTES`, so a hostile page cannot exhaust memory. */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - MAX_BODY_BYTES))));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
};

/** Decodes the entities that actually show up in text; numeric ones included. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity.startsWith("#x") || entity.startsWith("#X");
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const DROPPED_BLOCKS = /<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Reduces HTML to readable text. Not a parser: it drops the blocks a reader
 * would not see, keeps line structure at block boundaries, and collapses the
 * whitespace that markup padding leaves behind.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(DROPPED_BLOCKS, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote|table|ul|ol)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "· ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutBlocks)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `<title>` of a page, reduced to one line. */
export function pageTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return undefined;
  const title = htmlToText(match[1] ?? "").replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : undefined;
}

export class WebFetch implements Tool<{ url: string; max_chars?: number | undefined; raw?: boolean | undefined }> {
  readonly name = "web_fetch";
  readonly description =
    "Fetch a URL and return its readable text (scripts, styles and markup stripped) with the page title. Use it to read a doc page, a changelog or an issue. Set raw for the response exactly as served.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    url: z.string().describe("Absolute http(s) URL."),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(MAX_FETCH_CHARS)
      .optional()
      .describe(`Characters to keep, default ${DEFAULT_FETCH_CHARS}.`),
    raw: z.boolean().optional().describe("Return the body untouched, for JSON or plain text."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { url: string; max_chars?: number | undefined; raw?: boolean | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(
    input: { url: string; max_chars?: number; raw?: boolean },
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    // Checked before the request: scheme, and a host the agent has no business
    // reaching on its own (loopback, private ranges, cloud metadata).
    const problem = urlProblem(input.url);
    if (problem !== undefined) return { ok: false, output: "", error: problem };
    const limit = input.max_chars ?? DEFAULT_FETCH_CHARS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(input.url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
        redirect: "follow",
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      // A redirect can land somewhere the first check could not see.
      const landed = urlProblem(response.url || input.url);
      if (landed !== undefined) {
        return { ok: false, output: "", error: `redirected to a refused host: ${landed}` };
      }
      const body = await readBounded(response);
      if (!response.ok) {
        return {
          ok: false,
          output: body.slice(0, 500),
          error: `HTTP ${response.status} ${response.statusText} from ${input.url}`,
        };
      }
      const looksHtml = input.raw !== true && /html|xml/i.test(contentType);
      const title = looksHtml ? pageTitle(body) : undefined;
      const text = looksHtml ? htmlToText(body) : body.trim();
      const clipped = text.length > limit ? `${text.slice(0, limit)}\n… truncated at ${limit} characters` : text;
      const header = [`url: ${response.url || input.url}`, `status: ${response.status}`, `type: ${contentType || "unknown"}`];
      if (title !== undefined) header.push(`title: ${title}`);
      return { ok: true, output: `${header.join("\n")}\n\n${clipped}` };
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: `could not fetch ${input.url}: ${(error as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** DuckDuckGo redirects through /l/?uddg=…; the real target is in the query. */
function unwrapResultUrl(href: string): string {
  const decoded = decodeEntities(href);
  const match = /[?&]uddg=([^&]+)/.exec(decoded);
  if (match?.[1] === undefined) return decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return decoded;
  }
}

/**
 * Parses the HTML results page. Two passes rather than a DOM: the anchor classes
 * are stable, and a real parser would be a dependency for one screen of markup.
 */
/** Drops tracking parameters and the fragment: the page is the same without them. */
export function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    const text = url.toString();
    return url.search.length === 0 && text.endsWith("/") ? text.slice(0, -1) : text;
  } catch {
    return raw;
  }
}

/** DuckDuckGo answers a suspicious burst with a page that is not results. */
export function looksLikeChallenge(html: string): boolean {
  const text = htmlToText(html).slice(0, 4000).toLowerCase();
  if (text.includes("anomaly") || text.includes("unusual traffic") || text.includes("captcha")) return true;
  return /class="[^"]*(challenge|anomaly)/i.test(html);
}

export function parseSearchResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const links = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetList: string[] = [];
  for (const match of html.matchAll(snippets)) {
    snippetList.push(htmlToText(match[1] ?? "").replace(/\s+/g, " ").trim());
  }
  const seen = new Set<string>();
  const candidates: SearchHit[] = [];
  for (const match of html.matchAll(links)) {
    const rawUrl = unwrapResultUrl(match[1] ?? "");
    const title = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    // Sponsored placements route through /y.js and are not answers.
    if (/\/y\.js\?|duckduckgo\.com\/y\.js|ad_provider=/i.test(rawUrl)) continue;
    const url = cleanUrl(rawUrl);
    if (seen.has(url)) continue;
    // A result pointing at a private host is an injection, not a source.
    if (urlProblem(url) !== undefined) continue;
    seen.add(url);
    candidates.push({ title: title.length > 0 ? title : url, url, snippet: "" });
  }
  return candidates.slice(0, limit).map((hit, index) => ({
    ...hit,
    snippet: (snippetList[index] ?? "").slice(0, 300),
  }));
}

function searchEndpoint(): string {
  return process.env.CARLS_SEARCH_ENDPOINT ?? DEFAULT_SEARCH_ENDPOINT;
}

export class WebSearch implements Tool<{ query: string; max_results?: number | undefined }> {
  readonly name = "web_search";
  readonly description =
    "Search the web and return titles, URLs and snippets. Use it when the answer depends on something newer than the code: a library release, an error message, an API change. Follow up with web_fetch on the promising hit.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    query: z.string().min(1).describe("What to search for; phrase it like a search box, not a sentence."),
    max_results: z.number().int().positive().max(20).optional().describe("Results to return, default 6."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { query: string; max_results?: number | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: { query: string; max_results?: number }, _ctx: ToolContext): Promise<ToolResult> {
    const limit = input.max_results ?? 6;
    const primary = searchEndpoint();
    const endpoints = primary === FALLBACK_SEARCH_ENDPOINT ? [primary] : [primary, FALLBACK_SEARCH_ENDPOINT];
    const problems: string[] = [];
    let lastBody = "";

    for (const endpoint of endpoints) {
      for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
        const result = await requestSearch(endpoint, input.query);
        if (result.error !== undefined) {
          problems.push(`${endpoint}: ${result.error}`);
          await delay(SEARCH_RETRY_DELAY_MS * attempt);
          continue;
        }
        lastBody = result.body;
        // 429 and 5xx are worth one more try; a challenge is not, it needs a
        // different endpoint, and a 4xx is our bug.
        if (result.status === 429 || result.status >= 500) {
          problems.push(`${endpoint}: HTTP ${result.status}`);
          await delay(SEARCH_RETRY_DELAY_MS * attempt);
          continue;
        }
        if (result.status !== 200) {
          problems.push(`${endpoint}: HTTP ${result.status}`);
          break;
        }
        if (looksLikeChallenge(result.body)) {
          problems.push(`${endpoint}: challenge page (rate limited)`);
          break;
        }
        const hits = parseSearchResults(result.body, limit);
        if (hits.length === 0) {
          problems.push(`${endpoint}: no results parsed`);
          break;
        }
        const output = hits
          .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet.length > 0 ? `\n   ${hit.snippet}` : ""}`)
          .join("\n");
        return { ok: true, output: `${hits.length} results for "${input.query}"\n\n${output}` };
      }
    }

    return {
      ok: false,
      output: htmlToText(lastBody).slice(0, 400),
      error: `search failed (${problems.join("; ")}). Try a different query, or web_fetch a URL you already know.`,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One search request, bounded in time and size. Errors come back as data. */
async function requestSearch(
  endpoint: string,
  query: string,
): Promise<{ status: number; body: string; error?: undefined } | { error: string; status?: undefined; body?: undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html",
        "accept-language": "en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return { status: response.status, body: await readBounded(response) };
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
