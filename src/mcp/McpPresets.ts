import type { McpServerConfig } from "../config/Config.js";

/**
 * Ready-to-use MCP server recipes. `/mcp add <preset>` turns one of these into a
 * `.carls/mcp.json` entry, so a user gets a working server without having to
 * remember the package name, the transport or the token variable.
 *
 * `${...}` placeholders are expanded from the environment when the entry is
 * written, which is what keeps a token out of the config file.
 */
export interface McpPreset {
  /** Key used by `/mcp add <name>`. */
  name: string;
  /** One-line description shown by `/mcp presets`. */
  summary: string;
  /** Values the user must supply, expanded into `args`/`env` in order. */
  parameters: { key: string; hint: string; default?: string }[];
  /** The server config, with `${key}` placeholders for the parameters. */
  config: McpServerConfig;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    name: "filesystem",
    summary: "Read and write files under a directory tree",
    parameters: [{ key: "path", hint: "directory to expose", default: "." }],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "${path}"] },
  },
  {
    name: "github",
    summary: "Issues, pull requests and repository metadata",
    parameters: [{ key: "token", hint: "GitHub personal access token", default: "${GITHUB_TOKEN}" }],
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${token}" },
    },
  },
  {
    name: "playwright",
    summary: "Drive a browser: DOM snapshots, console errors, screenshots",
    parameters: [],
    config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  },
  {
    name: "sqlite",
    summary: "Query and inspect a local SQLite database",
    parameters: [{ key: "path", hint: "path to the .db file" }],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite", "${path}"] },
  },
  {
    name: "postgres",
    summary: "Read-only SQL access to a PostgreSQL database",
    parameters: [{ key: "url", hint: "postgres connection string", default: "${DATABASE_URL}" }],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${url}"] },
  },
  {
    name: "fetch",
    summary: "Fetch a URL and convert its HTML to markdown",
    parameters: [],
    config: { command: "uvx", args: ["mcp-server-fetch"] },
  },
  {
    name: "memory",
    summary: "A persistent knowledge graph the agent can write to",
    parameters: [],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  },
];

/** Looks a preset up by name. */
export function findPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.name === name);
}

/** Fills `${key}` placeholders in one string from `values`. */
function fill(value: string, values: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/**
 * Materialises a preset into a concrete server config. `values` supplies the
 * parameters; a parameter left out falls back to its default, and a default that
 * is itself a `${ENV}` reference stays as one so the expansion at load time
 * picks up the live environment.
 */
export function instantiatePreset(
  preset: McpPreset,
  values: Record<string, string>,
): McpServerConfig {
  const resolved: Record<string, string> = {};
  for (const parameter of preset.parameters) {
    resolved[parameter.key] = values[parameter.key] ?? parameter.default ?? "";
  }
  const config: McpServerConfig = {};
  if (preset.config.command !== undefined) config.command = fill(preset.config.command, resolved);
  if (preset.config.args !== undefined) config.args = preset.config.args.map((arg) => fill(arg, resolved));
  if (preset.config.url !== undefined) config.url = fill(preset.config.url, resolved);
  if (preset.config.transport !== undefined) config.transport = preset.config.transport;
  if (preset.config.env !== undefined) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(preset.config.env)) env[key] = fill(value, resolved);
    config.env = env;
  }
  return config;
}
