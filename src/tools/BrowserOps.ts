import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";

/**
 * Minimal structural typing for the slice of Playwright this module uses, so
 * the dependency stays optional and untyped at compile time.
 */
interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  title(): Promise<string>;
  url(): string;
  innerText(selector: string): Promise<string>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: { launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser> };
}

let browser: PlaywrightBrowser | undefined;
let page: PlaywrightPage | undefined;

async function loadPlaywright(): Promise<PlaywrightModule | undefined> {
  // The module name is a variable so TypeScript does not require Playwright to
  // be installed: the browser tools degrade with an install hint instead.
  const specifier = "playwright";
  try {
    return (await import(specifier)) as unknown as PlaywrightModule;
  } catch {
    return undefined;
  }
}

const INSTALL_HINT =
  "Playwright is not installed. Install it with: npm install playwright && npx playwright install --with-deps chromium";

async function ensurePage(): Promise<PlaywrightPage | ToolResult> {
  const playwright = await loadPlaywright();
  if (playwright === undefined) {
    return { ok: false, output: "", error: INSTALL_HINT };
  }
  if (page !== undefined) return page;
  browser = await playwright.chromium.launch({ headless: true });
  page = await browser.newPage();
  return page;
}

function isPage(value: PlaywrightPage | ToolResult): value is PlaywrightPage {
  return (value as ToolResult).ok === undefined;
}

/** Closes the shared browser. Called when the session ends. */
export async function closeBrowser(): Promise<void> {
  try {
    await browser?.close();
  } catch {
    // The browser may already be gone; nothing useful to do.
  }
  browser = undefined;
  page = undefined;
}

export class BrowserOpen implements Tool<{url: string; wait_for?: string  | undefined}> {
  readonly name = "browser_open";
  readonly description =
    "Open a URL in a headless browser and return the page title and visible text. Requires Playwright to be installed.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    url: z.string().describe("Absolute http(s) URL."),
    wait_for: z.string().optional().describe("CSS selector to wait for before reading the page."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { url: string; wait_for?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {url: string; wait_for?: string | undefined}, ctx: ToolContext): Promise<ToolResult> {
    if (!/^https?:\/\//.test(input.url)) return { ok: false, output: "", error: "url must start with http:// or https://" };
    const target = await ensurePage();
    if (!isPage(target)) return target;
    try {
      await target.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (input.wait_for !== undefined) await target.waitForSelector(input.wait_for, { timeout: 15_000 });
      const title = await target.title();
      const text = await target.evaluate<string>("document.body ? document.body.innerText : ''");
      return {
        ok: true,
        output: `url: ${target.url()}\ntitle: ${title}\n\n${cap(text)}`,
        metadata: { url: target.url(), title },
      };
    } catch (error) {
      return { ok: false, output: "", error: `browser_open failed: ${(error as Error).message}` };
    }
  }
}

export class BrowserClick implements Tool<{selector: string}> {
  readonly name = "browser_click";
  readonly description = "Click an element in the open browser page by CSS selector or text selector.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    selector: z.string().describe("CSS selector, or text=Some text to match by content."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { selector: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {selector: string}, _ctx: ToolContext): Promise<ToolResult> {
    if (page === undefined) return { ok: false, output: "", error: "No page is open. Call browser_open first." };
    try {
      await page.click(input.selector, { timeout: 15_000 });
      const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
      return { ok: true, output: `Clicked ${input.selector}.\n\n${cap(text)}`, metadata: { url: page.url() } };
    } catch (error) {
      return { ok: false, output: "", error: `browser_click failed: ${(error as Error).message}` };
    }
  }
}

export class BrowserType implements Tool<{selector: string; text: string; submit?: boolean  | undefined}> {
  readonly name = "browser_type";
  readonly description = "Type into a field in the open browser page, optionally pressing Enter to submit.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    selector: z.string().describe("CSS selector of the input."),
    text: z.string().describe("Text to enter."),
    submit: z.boolean().optional().describe("Press Enter after typing."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { selector: string; text: string; submit?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {selector: string; text: string; submit?: boolean | undefined}, _ctx: ToolContext): Promise<ToolResult> {
    if (page === undefined) return { ok: false, output: "", error: "No page is open. Call browser_open first." };
    try {
      await page.fill(input.selector, input.text);
      if (input.submit === true) await page.press(input.selector, "Enter");
      return { ok: true, output: `Typed into ${input.selector}${input.submit === true ? " and submitted" : ""}.` };
    } catch (error) {
      return { ok: false, output: "", error: `browser_type failed: ${(error as Error).message}` };
    }
  }
}

export class BrowserScreenshot implements Tool<{path?: string | undefined; full_page?: boolean  | undefined}> {
  readonly name = "browser_screenshot";
  readonly description = "Save a screenshot of the open browser page to a file.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    path: z.string().optional().describe("Output PNG path, defaults under .carls/screenshots."),
    full_page: z.boolean().optional().describe("Capture the whole scrollable page."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path?: string | undefined ; full_page?: boolean  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path?: string | undefined; full_page?: boolean | undefined}, ctx: ToolContext): Promise<ToolResult> {
    if (page === undefined) return { ok: false, output: "", error: "No page is open. Call browser_open first." };
    const target = guardPath(ctx, input.path ?? `.carls/screenshots/${Date.now()}.png`);
    try {
      await mkdir(dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: input.full_page === true });
      return { ok: true, output: `Screenshot saved to ${toDisplayPath(ctx.cwd, target)}.`, metadata: { path: target } };
    } catch (error) {
      return { ok: false, output: "", error: `browser_screenshot failed: ${(error as Error).message}` };
    }
  }
}

export class BrowserEval implements Tool<{expression: string}> {
  readonly name = "browser_eval";
  readonly description =
    "Run JavaScript in the open page and return the result as JSON. Use to read the DOM precisely or inspect app state.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    expression: z.string().describe("JavaScript expression evaluated in the page context."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { expression: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {expression: string}, _ctx: ToolContext): Promise<ToolResult> {
    if (page === undefined) return { ok: false, output: "", error: "No page is open. Call browser_open first." };
    try {
      const value = await page.evaluate<unknown>(`(() => { const v = (${input.expression}); return v === undefined ? null : v; })()`);
      return { ok: true, output: cap(JSON.stringify(value, null, 2) ?? "null") };
    } catch (error) {
      return { ok: false, output: "", error: `browser_eval failed: ${(error as Error).message}` };
    }
  }
}

export class BrowserText implements Tool<{selector?: string  | undefined}> {
  readonly name = "browser_text";
  readonly description = "Read the visible text of the page, or of one element.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    selector: z.string().optional().describe("CSS selector, defaults to the whole body."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { selector?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {selector?: string | undefined}, _ctx: ToolContext): Promise<ToolResult> {
    if (page === undefined) return { ok: false, output: "", error: "No page is open. Call browser_open first." };
    try {
      const text =
        input.selector === undefined
          ? await page.evaluate<string>("document.body ? document.body.innerText : ''")
          : await page.innerText(input.selector);
      return { ok: true, output: cap(text), metadata: { url: page.url() } };
    } catch (error) {
      return { ok: false, output: "", error: `browser_text failed: ${(error as Error).message}` };
    }
  }
}

export class BrowserClose implements Tool<Record<string, never>> {
  readonly name = "browser_close";
  readonly description = "Close the shared browser and release its memory.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaDef.parse(input);
  }

  async run(_input: Record<string, never>, _ctx: ToolContext): Promise<ToolResult> {
    const wasOpen = browser !== undefined;
    await closeBrowser();
    return { ok: true, output: wasOpen ? "Browser closed." : "No browser was open." };
  }
}

function cap(text: string): string {
  const limit = 12_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

export class BrowserSaveFile implements Tool<{path: string; content: string}> {
  readonly name = "browser_save_file";
  readonly description =
    "Write text to a file inside the workspace. Convenience wrapper used by browser flows that produce a file.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({
    path: z.string().describe("Destination path."),
    content: z.string().describe("File content."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { path: string; content: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {path: string; content: string}, ctx: ToolContext): Promise<ToolResult> {
    const target = guardPath(ctx, input.path);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
      return { ok: true, output: `Wrote ${toDisplayPath(ctx.cwd, target)}.`, metadata: { path: target } };
    } catch (error) {
      return { ok: false, output: "", error: `Cannot write: ${(error as Error).message}` };
    }
  }
}
