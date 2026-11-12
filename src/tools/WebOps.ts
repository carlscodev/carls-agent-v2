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
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_CHARS = 20_000;
const MAX_FETCH_CHARS = 200_000;
const USER_AGENT = "carls-code/1.0 (+terminal coding agent)";

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
    if (!/^https?:\/\//i.test(input.url)) {
      return { ok: false, output: "", error: "url must start with http:// or https://" };
    }
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
      const body = await response.text();
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
export function parseSearchResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const links = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetList: string[] = [];
  for (const match of html.matchAll(snippets)) {
    snippetList.push(htmlToText(match[1] ?? "").replace(/\s+/g, " ").trim());
  }
  for (const match of html.matchAll(links)) {
    if (hits.length >= limit) break;
    const url = unwrapResultUrl(match[1] ?? "");
    const title = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    hits.push({ title: title.length > 0 ? title : url, url, snippet: snippetList[hits.length] ?? "" });
  }
  return hits;
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
    const endpoint = searchEndpoint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(input.query)}`, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html",
          "accept-language": "en;q=0.9",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const html = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          output: "",
          error: `search endpoint answered HTTP ${response.status}. Try web_fetch on a known URL instead.`,
        };
      }
      const hits = parseSearchResults(html, limit);
      if (hits.length === 0) {
        return {
          ok: false,
          output: htmlToText(html).slice(0, 400),
          error: "no results were parsed; the endpoint may have returned a challenge page instead of results",
        };
      }
      const output = hits
        .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet.length > 0 ? `\n   ${hit.snippet}` : ""}`)
        .join("\n");
      return { ok: true, output: `${hits.length} results for "${input.query}"\n\n${output}` };
    } catch (error) {
      return { ok: false, output: "", error: `search failed: ${(error as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
