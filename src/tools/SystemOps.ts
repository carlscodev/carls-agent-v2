import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/tools.js";
import type { ToolSchema } from "../types/llm.js";
import { zodToJsonSchema } from "../utils/schema.js";
import { guardPath, toDisplayPath } from "../utils/paths.js";
import { run } from "./helpers.js";
import {
  clipboardCommands,
  isWindows,
  processListCommand,
  type ShellSpec,
} from "../utils/platform.js";

/** Environment variables whose values are replaced with a marker in output. */
const SECRET_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION)/i;

export class ProcessList implements Tool<{filter?: string  | undefined}> {
  readonly name = "process_list";
  readonly description =
    "List running processes with CPU and memory, optionally filtered by a substring. Use before killing anything.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    filter: z.string().optional().describe("Case-insensitive substring matched against the command line."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { filter?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {filter?: string | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const spec = processListCommand();
    const outcome = await run(spec.file, spec.args, {
      cwd: ctx.cwd,
      timeoutMs: 10_000,
      signal: ctx.signal,
    });
    if (outcome.exitCode !== 0) {
      return { ok: false, output: "", error: `${spec.label} failed: ${outcome.stderr.trim()}` };
    }
    const lines = outcome.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const body = isWindows() ? lines : lines.slice(1);
    const header = isWindows() ? "image,pid,session,mem" : (lines[0] ?? "");
    const filtered =
      input.filter === undefined || input.filter.length === 0
        ? body.slice(0, 40)
        : body.filter((line) => line.toLowerCase().includes(input.filter?.toLowerCase() ?? ""));
    return {
      ok: true,
      output: [header, ...filtered].join("\n"),
      metadata: { count: filtered.length, via: spec.label },
    };
  }
}

export class SystemInfo implements Tool<Record<string, never>> {
  readonly name = "system_info";
  readonly description = "Report OS, CPU, memory, load and disk usage of the machine running the agent.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaDef.parse(input);
  }

  async run(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const disk = isWindows()
      ? await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize | Out-String",
          ],
          { cwd: ctx.cwd, timeoutMs: 12_000, signal: ctx.signal },
        )
      : await run("df", ["-h", ctx.cwd], { cwd: ctx.cwd, timeoutMs: 8000, signal: ctx.signal });
    const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return {
      ok: true,
      output: [
        `host     ${hostname()}`,
        `os       ${platform()} ${release()}`,
        `node     ${process.version}`,
        `cpus     ${cpus().length}`,
        `memory   ${gb(totalmem() - freemem())} used of ${gb(totalmem())}`,
        `load     ${loadavg().map((value) => value.toFixed(2)).join(" ")}`,
        `uptime   ${(uptime() / 3600).toFixed(1)} h`,
        disk.exitCode === 0 ? `disk\n${disk.stdout.trim()}` : "disk     unavailable",
      ].join("\n"),
    };
  }
}

export class NetworkRequest implements Tool<{url: string; method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined; timeout_ms?: number | undefined}> {
  readonly name = "network_request";
  readonly description =
    "Make an HTTP request and return status, headers and body. Use to check an endpoint, an API or a health check.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    url: z.string().describe("Absolute http(s) URL."),
    method: z.string().optional().describe("HTTP method, defaults to GET."),
    headers: z.record(z.string()).optional().describe("Request headers."),
    body: z.string().optional().describe("Request body for POST/PUT/PATCH."),
    timeout_ms: z.number().int().positive().max(120_000).optional().describe("Timeout, default 30000."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): {
    url: string;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
    timeout_ms?: number | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(
    input: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout_ms?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!/^https?:\/\//.test(input.url)) {
      return { ok: false, output: "", error: "url must start with http:// or https://" };
    }
    const timeout = input.timeout_ms ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const startedAt = Date.now();
    try {
      const response = await fetch(input.url, {
        method: input.method ?? "GET",
        signal: controller.signal,
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      const text = await response.text();
      const capped = text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (${text.length - 20_000} more chars)` : text;
      const headerLines = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`);
      return {
        ok: response.ok,
        output: [`status ${response.status} ${response.statusText}`, ...headerLines, "", capped].join("\n"),
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
        metadata: { status: response.status, bytes: text.length, durationMs: Date.now() - startedAt },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Request failed: ${(error as Error).message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

export class HttpDownload implements Tool<{url: string; path: string; timeout_ms?: number  | undefined}> {
  readonly name = "http_download";
  readonly description = "Download a URL to a file, creating parent directories. Use for tarballs, fixtures or assets.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    url: z.string().describe("Absolute http(s) URL."),
    path: z.string().describe("Destination file path."),
    timeout_ms: z.number().int().positive().max(600_000).optional().describe("Timeout, default 120000."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { url: string; path: string; timeout_ms?: number  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {url: string; path: string; timeout_ms?: number | undefined}, ctx: ToolContext): Promise<ToolResult> {
    if (!/^https?:\/\//.test(input.url)) {
      return { ok: false, output: "", error: "url must start with http:// or https://" };
    }
    const target = guardPath(ctx, input.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeout_ms ?? 120_000);
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(input.url, { signal: controller.signal });
      if (!response.ok) {
        return { ok: false, output: "", error: `HTTP ${response.status} ${response.statusText}` };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buffer);
      return {
        ok: true,
        output: `Downloaded ${buffer.length} bytes to ${toDisplayPath(ctx.cwd, target)}.`,
        metadata: { path: target, bytes: buffer.length },
      };
    } catch (error) {
      return { ok: false, output: "", error: `Download failed: ${(error as Error).message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

export class EnvGet implements Tool<{name?: string | undefined; prefix?: string  | undefined}> {
  readonly name = "env_get";
  readonly description =
    "Read an environment variable, or list them. Values of secret-looking variables are redacted.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    name: z.string().optional().describe("Exact variable name."),
    prefix: z.string().optional().describe("List variables starting with this prefix."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { name?: string | undefined ; prefix?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {name?: string | undefined; prefix?: string | undefined}, _ctx: ToolContext): Promise<ToolResult> {
    const mask = (key: string, value: string): string =>
      SECRET_PATTERN.test(key) ? `<set:${value.length} chars>` : value;

    if (input.name !== undefined) {
      const value = process.env[input.name];
      if (value === undefined) return { ok: true, output: `${input.name} is not set.`, metadata: { set: false } };
      return { ok: true, output: `${input.name}=${mask(input.name, value)}`, metadata: { set: true } };
    }
    const prefix = input.prefix ?? "";
    const rows = Object.keys(process.env)
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => `${key}=${mask(key, process.env[key] ?? "")}`);
    return { ok: true, output: rows.join("\n") || "(no matching variables)", metadata: { count: rows.length } };
  }
}

export class EnvSet implements Tool<{name: string; value: string}> {
  readonly name = "env_set";
  readonly description =
    "Set an environment variable for this session, so later bash commands and requests see it. Does not persist across restarts.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid variable name"),
    value: z.string(),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { name: string; value: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {name: string; value: string}, ctx: ToolContext): Promise<ToolResult> {
    process.env[input.name] = input.value;
    ctx.logger.debug(`env_set ${input.name}`);
    return {
      ok: true,
      output: `Set ${input.name} for this session.`,
      metadata: { name: input.name, secret: SECRET_PATTERN.test(input.name) },
    };
  }
}

export class SleepWait implements Tool<{seconds: number; reason?: string  | undefined}> {
  readonly name = "sleep_wait";
  readonly description =
    "Pause for a number of seconds. Use when waiting for a service to come up or a rate limit to reset.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({
    seconds: z.number().positive().max(120).describe("Seconds to wait, at most 120."),
    reason: z.string().optional().describe("Why the wait is needed, shown in the transcript."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { seconds: number; reason?: string  | undefined } {
    return this.schemaDef.parse(input);
  }

  async run(input: {seconds: number; reason?: string | undefined}, ctx: ToolContext): Promise<ToolResult> {
    const ms = Math.min(120, input.seconds) * 1000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }).catch(() => undefined);
    return { ok: true, output: `Waited ${input.seconds}s${input.reason !== undefined ? ` (${input.reason})` : ""}.` };
  }
}

export class ClipboardRead implements Tool<Record<string, never>> {
  readonly name = "clipboard_read";
  readonly description =
    "Read the system clipboard. Uses PowerShell on Windows, pbpaste on macOS, and xclip or xsel on Linux.";
  readonly readOnly = true;
  readonly category = "read" as const;
  private readonly schemaDef = z.object({});

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): Record<string, never> {
    return this.schemaDef.parse(input);
  }

  async run(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const attempts: ShellSpec[] = clipboardCommands().read;
    for (const spec of attempts) {
      const outcome = await run(spec.file, spec.args, { cwd: ctx.cwd, timeoutMs: 8000, signal: ctx.signal });
      if (outcome.spawnError === undefined && outcome.exitCode === 0) {
        return { ok: true, output: outcome.stdout, metadata: { bytes: outcome.stdout.length, via: spec.label } };
      }
    }
    return {
      ok: false,
      output: "",
      error: isWindows()
        ? "Could not read the clipboard: PowerShell was not available."
        : "No clipboard tool found. Install xclip (apt install xclip), xsel or pbpaste.",
    };
  }
}

export class ClipboardWrite implements Tool<{text: string}> {
  readonly name = "clipboard_write";
  readonly description =
    "Copy text to the system clipboard. Uses PowerShell on Windows, pbcopy on macOS, and xclip or xsel on Linux.";
  readonly readOnly = false;
  readonly category = "write" as const;
  private readonly schemaDef = z.object({ text: z.string().describe("Text to place on the clipboard.") });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): { text: string } {
    return this.schemaDef.parse(input);
  }

  async run(input: {text: string}, ctx: ToolContext): Promise<ToolResult> {
    const attempts: ShellSpec[] = clipboardCommands().write;
    for (const spec of attempts) {
      const outcome = await run(spec.file, spec.args, {
        cwd: ctx.cwd,
        timeoutMs: 8000,
        signal: ctx.signal,
        input: input.text,
      });
      if (outcome.spawnError === undefined && outcome.exitCode === 0) {
        return { ok: true, output: `Copied ${input.text.length} characters to the clipboard via ${spec.label}.` };
      }
    }
    return {
      ok: false,
      output: "",
      error: isWindows()
        ? "Could not write the clipboard: PowerShell was not available."
        : "No clipboard tool found. Install xclip (apt install xclip), xsel or pbcopy.",
    };
  }
}

export class ComputerUse implements Tool<{action: "screenshot" | "click" | "type" | "key" | "move" | "scroll"; x?: number | undefined; y?: number | undefined; text?: string | undefined; key?: string | undefined; path?: string | undefined}> {
  readonly name = "computer_use";
  readonly description =
    "Control the graphical desktop: take a screenshot, move the pointer, click, type text, press a key or scroll. Requires xdotool and ImageMagick (or scrot) on X11.";
  readonly readOnly = false;
  readonly category = "shell" as const;
  private readonly schemaDef = z.object({
    action: z.enum(["screenshot", "click", "type", "key", "move", "scroll"]).describe("What to do."),
    x: z.number().int().optional().describe("X coordinate for move, click or scroll."),
    y: z.number().int().optional().describe("Y coordinate for move, click or scroll."),
    text: z.string().optional().describe("Text to type."),
    key: z.string().optional().describe("Key or chord to press, e.g. Return, ctrl+c, alt+Tab."),
    path: z.string().optional().describe("Screenshot output path, defaults to a temp file in the workspace."),
  });

  schema(): ToolSchema {
    return { name: this.name, description: this.description, input_schema: zodToJsonSchema(this.schemaDef) };
  }

  parse(input: unknown): {
    action: "screenshot" | "click" | "type" | "key" | "move" | "scroll";
    x?: number | undefined;
    y?: number | undefined;
    text?: string | undefined;
    key?: string | undefined;
    path?: string | undefined } {
    return this.schemaDef.parse(input);
  }

  private async available(command: string, ctx: ToolContext): Promise<boolean> {
    const outcome = await run("which", [command], { cwd: ctx.cwd, timeoutMs: 5000, signal: ctx.signal });
    return outcome.exitCode === 0 && outcome.stdout.trim().length > 0;
  }

  async run(
    input: {
      action: "screenshot" | "click" | "type" | "key" | "move" | "scroll";
      x?: number | undefined;
      y?: number | undefined;
      text?: string | undefined;
      key?: string | undefined;
      path?: string | undefined;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) {
      return {
        ok: false,
        output: "",
        error:
          "No graphical session detected (DISPLAY is unset). computer_use needs an X11 display; start one with Xvfb, for example: Xvfb :99 -screen 0 1280x800x24 & export DISPLAY=:99",
      };
    }

    if (input.action === "screenshot") {
      const target = guardPath(ctx, input.path ?? `.carls/screenshots/${Date.now()}.png`);
      await mkdir(dirname(target), { recursive: true });
      for (const [command, args] of [
        ["import", ["-window", "root", target]],
        ["scrot", [target]],
        ["gnome-screenshot", ["-f", target]],
      ] as [string, string[]][]) {
        if (!(await this.available(command, ctx))) continue;
        const outcome = await run(command, args, { cwd: ctx.cwd, timeoutMs: 20_000, signal: ctx.signal });
        if (outcome.exitCode === 0) {
          return {
            ok: true,
            output: `Screenshot written to ${toDisplayPath(ctx.cwd, target)}. Read it with read_file if it is text, or inspect the file directly.`,
            metadata: { path: target },
          };
        }
      }
      return { ok: false, output: "", error: "No screenshot tool found. Install imagemagick (import) or scrot." };
    }

    if (!(await this.available("xdotool", ctx))) {
      return { ok: false, output: "", error: "xdotool is required for pointer and keyboard control. Install it: apt install xdotool" };
    }

    const args: string[] = [];
    switch (input.action) {
      case "move":
        if (input.x === undefined || input.y === undefined) return this.needsCoordinates();
        args.push("mousemove", String(input.x), String(input.y));
        break;
      case "click":
        if (input.x !== undefined && input.y !== undefined) args.push("mousemove", String(input.x), String(input.y));
        args.push("click", "1");
        break;
      case "type":
        if (input.text === undefined) return { ok: false, output: "", error: "action=type needs text." };
        args.push("type", "--delay", "12", input.text);
        break;
      case "key":
        if (input.key === undefined) return { ok: false, output: "", error: "action=key needs key." };
        args.push("key", input.key);
        break;
      case "scroll":
        if (input.x === undefined || input.y === undefined) return this.needsCoordinates();
        args.push("mousemove", String(input.x), String(input.y), "click", input.y >= 0 ? "4" : "5");
        break;
    }

    const outcome = await run("xdotool", args, { cwd: ctx.cwd, timeoutMs: 20_000, signal: ctx.signal });
    if (outcome.exitCode !== 0) {
      return { ok: false, output: "", error: `xdotool failed: ${outcome.stderr.trim() || `exit ${outcome.exitCode}`}` };
    }
    return { ok: true, output: `computer_use ${input.action} done.` };
  }

  private needsCoordinates(): ToolResult {
    return { ok: false, output: "", error: "This action needs x and y coordinates." };
  }
}
