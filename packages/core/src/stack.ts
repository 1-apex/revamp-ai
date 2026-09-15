import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface StackInfo {
  hasPackageJson: boolean;
  reactVersion: string | null;
  buildTool: "vite" | "next" | "unknown";
  tailwind: { present: boolean; major: number | null; themeFile: string | null };
  shadcn: { present: boolean; componentsJsonPath: string | null; aliasComponents: string | null };
  packageManager: "npm" | "pnpm" | "yarn" | "unknown";
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Find the nearest package.json walking up from a start dir isn't needed
 * here — we scan a single project root, so this just reads root/package.json. */
function readPackageJson(rootDir: string): any | null {
  return readJson(path.join(rootDir, "package.json"));
}

function detectBuildTool(rootDir: string, pkg: any | null): StackInfo["buildTool"] {
  if (existsSync(path.join(rootDir, "next.config.js")) || existsSync(path.join(rootDir, "next.config.ts")) || existsSync(path.join(rootDir, "next.config.mjs"))) {
    return "next";
  }
  if (existsSync(path.join(rootDir, "vite.config.ts")) || existsSync(path.join(rootDir, "vite.config.js"))) {
    return "vite";
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.next) return "next";
  if (deps.vite) return "vite";
  return "unknown";
}

/** Tailwind v4 is CSS-first — there may be no tailwind.config.js at all.
 * The reliable signal is `@import "tailwindcss"` plus a `@theme { ... }`
 * block in a CSS file, so we search for that rather than assuming a config
 * file exists. */
function detectTailwind(rootDir: string, pkg: any | null): StackInfo["tailwind"] {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const version: string | undefined = deps.tailwindcss;
  const major = version ? Number.parseInt(version.replace(/[^\d.]/g, "").split(".")[0] || "0", 10) : null;

  const candidateCssFiles = findFilesShallow(rootDir, [".css"], 4);
  let themeFile: string | null = null;
  for (const f of candidateCssFiles) {
    const content = readFileSync(f, "utf8");
    if (content.includes('@import "tailwindcss"') || content.includes("@tailwind base")) {
      if (content.includes("@theme")) themeFile = f;
      if (!themeFile) themeFile = f; // record even without an explicit @theme block yet
    }
  }
  return { present: Boolean(version) || Boolean(themeFile), major, themeFile };
}

function detectShadcn(rootDir: string): StackInfo["shadcn"] {
  const all = findFilesShallow(rootDir, ["components.json"], 4);
  const candidates = all.filter((f) => f.endsWith("components.json"));
  if (candidates.length === 0) return { present: false, componentsJsonPath: null, aliasComponents: null };
  const json = readJson(candidates[0]);
  return {
    present: true,
    componentsJsonPath: candidates[0],
    aliasComponents: json?.aliases?.components ?? null,
  };
}

function detectPackageManager(rootDir: string): StackInfo["packageManager"] {
  if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(rootDir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(rootDir, "package-lock.json"))) return "npm";
  return "unknown";
}

/** Shallow recursive file finder that skips node_modules/dist/.git — good
 * enough for locating config-ish files without pulling in fast-glob for
 * every tiny lookup. */
function findFilesShallow(dir: string, matchers: string[], maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (["node_modules", "dist", ".git", "build", ".next"].includes(entry)) continue;
    const full = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      results.push(...findFilesShallow(full, matchers, maxDepth, depth + 1));
    } else if (matchers.some((m) => (m.startsWith(".") ? entry.endsWith(m) : entry === m))) {
      results.push(full);
    }
  }
  return results;
}

export function detectStack(rootDir: string): StackInfo {
  const pkg = readPackageJson(rootDir);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return {
    hasPackageJson: Boolean(pkg),
    reactVersion: deps.react ?? null,
    buildTool: detectBuildTool(rootDir, pkg),
    tailwind: detectTailwind(rootDir, pkg),
    shadcn: detectShadcn(rootDir),
    packageManager: detectPackageManager(rootDir),
  };
}
