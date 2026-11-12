import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { ResolvedConfig } from "../config/Config.js";
import { specFor } from "../config/Config.js";
import { fetchModels } from "../models/Catalog.js";
import { discoverLocalBackends } from "../providers/discovery.js";
import { compareVersions, readUpdateCache } from "../update/Updater.js";
import { packageVersion } from "../core/Runtime.js";

/**
 * Builds the diagnostic rows shown by `/doctor` and `carls --doctor`. Shared so
 * the two paths cannot drift.
 */
export async function collectDoctorRows(config: ResolvedConfig): Promise<string[]> {
  const rows: string[] = [];
  const ok = (label: string, value: string): void => {
    rows.push(`${pc.green("✓")} ${label.padEnd(12)} ${pc.gray(value)}`);
  };
  const bad = (label: string, value: string): void => {
    rows.push(`${pc.red("✗")} ${label.padEnd(12)} ${pc.gray(value)}`);
  };

  ok("node", process.version);
  const spec = specFor(config.provider);
  rows.push(
    `${pc.green("✓")} ${"provider".padEnd(12)} ${pc.gray(
      spec !== undefined
        ? `${spec.label} (${spec.family}, ${spec.protocol})`
        : `${config.provider} (custom id)`,
    )}`,
  );
  ok("cwd", config.cwd);
  if (existsSync(join(config.cwd, ".git"))) ok("git", "repository detected");
  else rows.push(`${pc.yellow("•")} git          ${pc.gray("no .git in cwd")}`);

  if (config.apiKey !== undefined) {
    rows.push(`${pc.yellow("•")} apiKey       ${pc.gray("present in config file (600 recommended)")}`);
  }
  const envNames = spec?.apiKeyEnv ?? [config.apiKeyEnv];
  const foundEnv = envNames.find((name) => (process.env[name] ?? "").length > 0);
  if (foundEnv !== undefined) ok("apiKeyEnv", foundEnv);
  else if (spec?.keyless === true) ok("apiKeyEnv", "not required for this provider");
  else rows.push(`${pc.yellow("•")} apiKeyEnv    ${pc.gray(`${envNames.join(" or ")} unset`)}`);
  rows.push(
    `${config.allowOutsideWorkspace ? pc.yellow("•") : pc.green("✓")} ${"workspace".padEnd(12)} ${pc.gray(
      config.allowOutsideWorkspace ? "tools may touch paths outside cwd" : "tools are confined to cwd",
    )}`,
  );

  try {
    const models = await fetchModels(config);
    ok("endpoint", `${config.baseUrl} · ${models.length} models`);
    // The context window drives compaction. When the endpoint reports it, say so,
    // because a mismatch is what makes a long session truncate silently.
    const declared = models.find((model) => model.id === config.model)?.contextWindow;
    if (declared !== undefined && declared !== config.contextWindow) {
      rows.push(
        `${pc.yellow("•")} ${"context".padEnd(12)} ${pc.gray(
          `endpoint reports ${declared.toLocaleString()}, config uses ${config.contextWindow.toLocaleString()}`,
        )}`,
      );
    }
  } catch (error) {
    bad("endpoint", (error as Error).message.slice(0, 90));
  }

  const mcpEntries = Object.entries(config.mcpServers);
  if (mcpEntries.length === 0) {
    rows.push(`${pc.gray("•")} ${"mcp".padEnd(12)} ${pc.gray("no servers configured")}`);
  } else {
    // A remote server that is down is the usual reason a tool goes missing, so
    // name the transport here instead of only counting entries.
    const summary = mcpEntries
      .map(([name, server]) => `${name} (${server.transport ?? (server.url !== undefined ? "http" : "stdio")})`)
      .join(", ");
    rows.push(`${pc.green("✓")} ${"mcp".padEnd(12)} ${pc.gray(summary)}`);
  }

  const version = packageVersion();
  const cached = readUpdateCache();
  if (cached === undefined) {
    rows.push(`${pc.gray("•")} ${"update".padEnd(12)} ${pc.gray(`carls ${version} · run carls --update-check`)}`);
  } else if (compareVersions(cached.latest, version) > 0) {
    rows.push(
      `${pc.yellow("•")} ${"update".padEnd(12)} ${pc.gray(`${version} → ${cached.latest} available (carls update)`)}`,
    );
  } else {
    rows.push(`${pc.green("✓")} ${"update".padEnd(12)} ${pc.gray(`${version} is current`)}`);
  }

  // Only probe localhost when the configured provider is not already local, so
  // a cloud user does not pay for four failed connections on every /doctor.
  if (spec?.local !== true) {
    const local = await discoverLocalBackends();
    if (local.length > 0) {
      const summary = local
        .map((backend) => `${backend.provider} (${backend.models.length} models)`)
        .join(", ");
      rows.push(
        `${pc.yellow("•")} ${"local".padEnd(12)} ${pc.gray(`detected: ${summary}`)}`,
      );
    }
  }
  return rows;
}
