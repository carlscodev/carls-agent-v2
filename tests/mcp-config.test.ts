import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  expandEnv,
  expandMcpServer,
  expandMcpServers,
  loadConfig,
} from "../src/config/Config.js";
import type { McpServerConfig } from "../src/config/Config.js";
import { findPreset, instantiatePreset, MCP_PRESETS } from "../src/mcp/McpPresets.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { FileRead } from "../src/tools/FileRead.js";
import { BashExecution } from "../src/tools/BashExecution.js";
import { Logger } from "../src/utils/Logger.js";
import { Runtime } from "../src/core/Runtime.js";
import { SessionStore } from "../src/core/SessionStore.js";
import type { Tool } from "../src/types/tools.js";

let dir: string;
let logger: Logger;
let previousHome: string | undefined;
let previousAppData: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "carls-mcp-"));
  logger = new Logger("error");
  // Keep the machine-level and user-level config out of the merge so an
  // assertion about a layer cannot be shadowed by a real file on the host.
  process.env.CARLS_SYSTEM_CONFIG = join(dir, "no-system-config.json");
  previousHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  previousAppData = process.env.APPDATA;
  process.env.APPDATA = join(dir, "appdata");
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in MCP tool so the registry filter can be exercised without a server. */
function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} (fake)`,
    category: "read",
    readOnly: true,
    schema: () => ({ name, description: `${name} (fake)`, input_schema: { type: "object", properties: {} } }),
    parse: (input: unknown) => input as Record<string, unknown>,
    run: async () => ({ ok: true, output: "" }),
  };
}

describe("mcp env expansion", () => {
  it("expands only the variables that exist, leaving the rest verbatim", () => {
    const env = { TOKEN: "s3cret" };
    expect(expandEnv("Bearer ${TOKEN}", env)).toBe("Bearer s3cret");
    // An undefined variable is left intact so the operator sees what is missing
    // instead of a silently empty string.
    expect(expandEnv("Bearer ${MISSING}", env)).toBe("Bearer ${MISSING}");
    expect(expandEnv("no vars here", env)).toBe("no vars here");
  });

  it("expands command, args, url and env, and preserves the transport", () => {
    const expanded = expandMcpServer(
      {
        command: "${BIN}",
        args: ["-y", "${PKG}", "--dir", "${DIR}"],
        url: "https://${HOST}/mcp",
        transport: "http",
        env: { API_KEY: "${KEY}" },
      },
      { BIN: "npx", PKG: "server", DIR: "/tmp", HOST: "example.test", KEY: "abc" },
    );
    expect(expanded).toEqual({
      command: "npx",
      args: ["-y", "server", "--dir", "/tmp"],
      url: "https://example.test/mcp",
      transport: "http",
      env: { API_KEY: "abc" },
    });
  });

  it("expands every server in a map and tolerates undefined", () => {
    expect(expandMcpServers(undefined, {})).toEqual({});
    const out = expandMcpServers(
      { a: { command: "${CMD}" }, b: { url: "${URL}" } },
      { CMD: "run", URL: "http://x" },
    );
    expect(out).toEqual({ a: { command: "run" }, b: { url: "http://x" } });
  });
});

describe("mcp config loading", () => {
  it("reads a bare .carls/mcp.json map and expands it at load time", async () => {
    await mkdir(join(dir, ".carls"), { recursive: true });
    await writeFile(
      join(dir, ".carls", "mcp.json"),
      JSON.stringify({ local: { command: "npx", args: ["-y", "${PKG}"] } }),
      "utf8",
    );
    const saved = process.env.PKG;
    process.env.PKG = "the-package";
    try {
      const config = loadConfig({}, dir);
      expect(config.mcpServers).toEqual({ local: { command: "npx", args: ["-y", "the-package"] } });
    } finally {
      if (saved === undefined) delete process.env.PKG;
      else process.env.PKG = saved;
    }
  });

  it("also accepts the { mcpServers } spelling", async () => {
    await mkdir(join(dir, ".carls"), { recursive: true });
    await writeFile(
      join(dir, ".carls", "mcp.json"),
      JSON.stringify({ mcpServers: { nested: { url: "http://127.0.0.1:9/mcp" } } }),
      "utf8",
    );
    const config = loadConfig({}, dir);
    expect(config.mcpServers).toEqual({ nested: { url: "http://127.0.0.1:9/mcp" } });
  });

  it("lets .carlsrc.json mcpServers win over .carls/mcp.json for the same name", async () => {
    await mkdir(join(dir, ".carls"), { recursive: true });
    await writeFile(
      join(dir, ".carls", "mcp.json"),
      JSON.stringify({ shared: { command: "from-mcp-json" }, onlyFile: { command: "keep" } }),
      "utf8",
    );
    await writeFile(
      join(dir, ".carlsrc.json"),
      JSON.stringify({ mcpServers: { shared: { command: "from-carlsrc" } } }),
      "utf8",
    );
    const config = loadConfig({}, dir);
    expect(config.mcpServers.shared).toEqual({ command: "from-carlsrc" });
    // A server only present in the mcp.json file survives the merge.
    expect(config.mcpServers.onlyFile).toEqual({ command: "keep" });
  });
});

describe("mcp presets", () => {
  it("finds presets by name and reports an unknown one", () => {
    expect(findPreset("filesystem")?.name).toBe("filesystem");
    expect(findPreset("nope")).toBeUndefined();
    // Every preset is addressable by `/mcp add <name>`, so names must be unique.
    const names = MCP_PRESETS.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("fills parameters from values and falls back to defaults", () => {
    const preset = findPreset("filesystem");
    expect(preset).toBeDefined();
    const filled = instantiatePreset(preset as NonNullable<typeof preset>, { path: "/srv/code" });
    expect(filled.args).toContain("/srv/code");

    // No value supplied: the parameter default (".") is used.
    const defaulted = instantiatePreset(preset as NonNullable<typeof preset>, {});
    expect(defaulted.args?.at(-1)).toBe(".");
  });

  it("keeps an env-reference default intact so load-time expansion resolves it", () => {
    const preset = findPreset("github");
    expect(preset).toBeDefined();
    const config = instantiatePreset(preset as NonNullable<typeof preset>, {});
    // The token is not baked in at instantiation; it stays a reference.
    expect(config.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("${GITHUB_TOKEN}");
    const expanded = expandMcpServer(config, { GITHUB_TOKEN: "ghp_live" });
    expect(expanded.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_live");
  });
});

describe("tool registry mcp filter", () => {
  it("withoutMcp drops namespaced tools and keeps the rest, leaving the source intact", () => {
    const registry = new ToolRegistry();
    registry.register(new FileRead());
    registry.register(fakeTool("mcp__github__create_issue"));
    registry.register(fakeTool("mcp__local__ping"));

    const lean = registry.withoutMcp();
    expect(lean.names()).toContain("read_file");
    expect(lean.names().some((name) => name.startsWith("mcp__"))).toBe(false);
    // The original registry is untouched, so a non-fast-path turn still has them.
    expect(registry.names()).toContain("mcp__github__create_issue");
    expect(registry.has("mcp__local__ping")).toBe(true);
  });
});

/**
 * A minimal MCP server over stdio. Answers the handshake, lists one tool and
 * replies to `ping`, which is everything the runtime wiring exercises.
 */
const FAKE_STDIO_SERVER = [
  'let buffer = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buffer += chunk;",
  '  let index = buffer.indexOf("\\n");',
  "  while (index !== -1) {",
  "    const line = buffer.slice(0, index);",
  "    buffer = buffer.slice(index + 1);",
  '    index = buffer.indexOf("\\n");',
  "    if (!line.trim()) continue;",
  "    const message = JSON.parse(line);",
  "    if (message.id === undefined) continue;",
  "    const result = message.method === 'initialize'",
  "      ? { protocolVersion: '2025-03-26', serverInfo: { name: 'fake-stdio', version: '2.0.0' } }",
  "      : message.method === 'tools/list'",
  "      ? { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] }",
  "      : message.method === 'tools/call'",
  "      ? { content: [{ type: 'text', text: 'pong' }] }",
  "      : {};",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
  "  }",
  "});",
].join("\n");

describe("runtime mcp wiring", () => {
  const config = (workspace: string) => {
    const base = loadConfig({}, workspace);
    return { ...base, apiKey: "test-key" };
  };

  it("connects a configured stdio server, registers its tools and answers ping", async () => {
    const workspace = join(dir, "wired");
    await mkdir(workspace, { recursive: true });
    const cfg = config(workspace);
    cfg.mcpServers = {
      fake: { command: process.execPath, args: ["-e", FAKE_STDIO_SERVER] } satisfies McpServerConfig,
    };
    const session = new SessionStore(workspace, cfg.model, undefined, join(workspace, "sessions"));
    const runtime = new Runtime({ config: cfg, logger, session });
    try {
      await runtime.connectMcpServers();

      // The tool is registered under the namespaced name and advertised.
      expect(runtime.registry.has("mcp__fake__ping")).toBe(true);
      expect(runtime.mcpServers()).toEqual([
        { name: "fake", transport: "stdio", tools: 1, version: "2.0.0" },
      ]);

      // The live client round-trips a ping, which is what `/mcp test` relies on.
      const client = runtime.mcpClient("fake");
      expect(client).toBeDefined();
      const latency = await client?.ping(2000);
      expect(typeof latency).toBe("number");
      expect(latency).toBeGreaterThanOrEqual(0);

      // The fast path advertises the same set without the MCP schemas.
      expect(runtime.registry.withoutMcp().has("mcp__fake__ping")).toBe(false);
      expect(runtime.registry.withoutMcp().names()).toContain("read_file");
    } finally {
      await runtime.close();
    }
  });

  it("reports a broken server as unavailable instead of failing the turn", async () => {
    const workspace = join(dir, "broken");
    await mkdir(workspace, { recursive: true });
    const cfg = config(workspace);
    cfg.mcpServers = { dead: { command: join(workspace, "does-not-exist") } };
    const session = new SessionStore(workspace, cfg.model, undefined, join(workspace, "sessions"));
    const runtime = new Runtime({ config: cfg, logger, session });
    try {
      // connectMcpServers swallows the failure; a bad server must not be fatal.
      await expect(runtime.connectMcpServers()).resolves.toBeUndefined();
      expect(runtime.mcpServers()).toEqual([]);
      expect(runtime.registry.names().some((name) => name.startsWith("mcp__"))).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("persists an added server to .carls/mcp.json, merged with what is there", async () => {
    const workspace = join(dir, "persist");
    await mkdir(join(workspace, ".carls"), { recursive: true });
    await writeFile(
      join(workspace, ".carls", "mcp.json"),
      JSON.stringify({ existing: { command: "keep-me" } }),
      "utf8",
    );
    const cfg = config(workspace);
    const session = new SessionStore(workspace, cfg.model, undefined, join(workspace, "sessions"));
    const runtime = new Runtime({ config: cfg, logger, session });
    try {
      const result = await runtime.addMcpServer("fake", {
        command: process.execPath,
        args: ["-e", FAKE_STDIO_SERVER],
      });
      expect(result.ok).toBe(true);
      expect(result.tools).toBe(1);

      const written = JSON.parse(
        await readFile(join(workspace, ".carls", "mcp.json"), "utf8"),
      ) as { mcpServers?: Record<string, unknown> };
      expect(written.mcpServers?.fake).toMatchObject({ command: process.execPath });

      // Reading the file back is what proves the merge is not lossy: the entry
      // that was already there must survive a reload, not just a raw JSON peek.
      const reloaded = loadConfig({}, workspace);
      expect(reloaded.mcpServers.existing).toEqual({ command: "keep-me" });
      expect(reloaded.mcpServers.fake).toMatchObject({ command: process.execPath });
      // The in-memory config is updated too, so a later turn sees the server.
      expect(runtime.config.mcpServers.fake).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it("skips a tool whose namespaced name already exists", async () => {
    const workspace = join(dir, "collide");
    await mkdir(workspace, { recursive: true });
    const cfg = config(workspace);
    const session = new SessionStore(workspace, cfg.model, undefined, join(workspace, "sessions"));
    const runtime = new Runtime({ config: cfg, logger, session });
    try {
      const server = { command: process.execPath, args: ["-e", FAKE_STDIO_SERVER] };
      const first = await runtime.connectMcpServer("one", server);
      // A second connect under the same server name produces the same namespaced
      // name (`mcp__one__ping`), so the guard keeps the first live wrapper.
      const second = await runtime.connectMcpServer("one", server);
      expect(first.tools).toBe(1);
      expect(second.ok).toBe(true);
      expect(second.tools).toBe(0);
      expect(runtime.registry.has("mcp__one__ping")).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
