import pc from "picocolors";
import { providersByFamily, PROVIDERS } from "../providers/registry.js";
import { apiKeyEnvFor, defaultModelFor } from "../config/Config.js";

/** Human-readable table of every bundled provider, used by `carls --providers`. */
export function formatProviderTable(): string {
  const lines: string[] = [];
  lines.push(`${pc.bold("Providers")} ${pc.gray(`(${PROVIDERS.length})`)}`);
  lines.push("");
  for (const group of providersByFamily()) {
    lines.push(pc.bold(pc.cyan(group.family)));
    for (const provider of group.providers) {
      const id = provider.id.padEnd(16);
      const label = provider.label.padEnd(28);
      const env = apiKeyEnvFor(provider.id);
      const key = provider.keyless === true ? pc.green("no key needed") : pc.gray(env);
      lines.push(`  ${pc.cyan(id)} ${label} ${key}`);
      lines.push(`${" ".repeat(19)}${pc.gray(`model ${defaultModelFor(provider.id)} · ${provider.baseUrl}`)}`);
      if (provider.note !== undefined) lines.push(`${" ".repeat(19)}${pc.gray(provider.note)}`);
    }
    lines.push("");
  }
  lines.push(
    pc.gray("Pick one with ") +
      pc.bold("carls --setup") +
      pc.gray(", or set provider/apiKey/baseUrl in .carlsrc.json."),
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}
