import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the running program keeps its own files.
 *
 * The same code runs from three shapes: TypeScript sources under `src/` through
 * `tsx`, compiled files under `dist/src/`, and a single CJS bundle that may be
 * embedded in `carls.exe` (Node SEA). `import.meta.url` exists only in the first
 * two; a bundled CJS module gets `__dirname` instead, and inside SEA that points
 * at the executable. Both are probed without assuming either is defined, so a
 * bad guess degrades to "asset not found" rather than a startup crash.
 */

export function moduleDirectory(): string | undefined {
  try {
    const url = import.meta.url;
    if (typeof url === "string" && url.startsWith("file:")) return dirname(fileURLToPath(url));
  } catch {
    // A CJS bundle has no import.meta; fall through to __dirname.
  }
  if (typeof __dirname === "string" && __dirname.length > 0) return __dirname;
  return undefined;
}

/** Directories that may contain package.json, skills/ or a config template. */
export function runtimeRoots(): string[] {
  const roots = new Set<string>();
  const add = (start: string | undefined, levels: number): void => {
    let current = start;
    for (let index = 0; index <= levels && current !== undefined; index++) {
      roots.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };

  // Module first: in a checkout this finds the repository root, and in a
  // bundle it finds the directory that holds the .cjs and the launcher.
  add(moduleDirectory(), 4);
  if (process.execPath.length > 0) add(dirname(process.execPath), 2);
  if (process.env.CARLS_HOME !== undefined && process.env.CARLS_HOME.length > 0) {
    add(process.env.CARLS_HOME, 1);
  }
  return [...roots];
}

export function findRuntimeAsset(relativePath: string): string | undefined {
  for (const root of runtimeRoots()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findRuntimeDirectory(relativePath: string): string | undefined {
  for (const root of runtimeRoots()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
