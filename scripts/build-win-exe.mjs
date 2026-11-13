#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Build entry point for the Windows single-file distribution.
 *
 * The logic lives in `src/os/WindowsNativeBuild.ts` so it can be tested from
 * Vitest; this file is only argument parsing and a smoke check of the result.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = join(root, "dist", "src", "os", "WindowsNativeBuild.js");

const usage = [
  "Usage: node scripts/build-win-exe.mjs <--bundle-only | --exe>",
  "",
  "  --bundle-only  Write release/carls.bundle.cjs and release/carls.cmd",
  "  --exe          Build the bundle and release/carls.exe (run `npm run build` first)",
  "  --help         Show this message",
  "",
].join("\n");

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

const bundleOnly = argv.includes("--bundle-only");
const exe = argv.includes("--exe");
if (bundleOnly === exe) {
  process.stderr.write(usage);
  process.exit(2);
}

if (!existsSync(compiled)) {
  process.stderr.write(
    "error: dist/src/os/WindowsNativeBuild.js is missing. Run `npm run build` first.\n",
  );
  process.exit(1);
}

const api = await import(pathToFileURL(compiled).href);
const layout = api.buildLayout(root);
const log = (line) => process.stdout.write(`${line}\n`);

try {
  if (bundleOnly) {
    const artifact = await api.buildBundle(layout, { log });
    api.writeBundleLauncher(layout);
    const version = execFileSync(process.execPath, [layout.bundleFile, "--version"], {
      encoding: "utf8",
      timeout: 60000,
    }).trim();
    log(`bundle: ${artifact.bundleFile} (${artifact.bytes} bytes, carls ${version})`);
    log(`launcher: ${layout.cmdFile}`);
    log(`verified: node carls.bundle.cjs --version -> ${version}`);
  } else {
    const artifact = await api.buildExecutable(layout, { log, rebuildBundle: true });
    const version = execFileSync(layout.exeFile, ["--version"], {
      encoding: "utf8",
      timeout: 60000,
    }).trim();
    log(
      `exe: ${artifact.exeFile} (${artifact.bytes} bytes, injected by ${artifact.injectedBy})`,
    );
    log(`bundle: ${artifact.bundleFile} (${artifact.bundleBytes} bytes)`);
    log(`blob: ${artifact.blobFile}`);
    log(`launcher: ${artifact.cmdFile}`);
    log(`verified: carls.exe --version -> ${version}`);
  }
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
