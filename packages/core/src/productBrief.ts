import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentInfo } from "./components.js";

export interface ProductBrief {
  name: string | null;
  description: string | null;
  readmeSummary: string | null;
  routeNames: string[];
  entityHints: string[];
  brief: string;
}

function readPackageJson(rootDir: string): any | null {
  try {
    return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function firstReadmeParagraph(rootDir: string): string | null {
  for (const candidate of ["README.md", "readme.md", "Readme.md"]) {
    const p = path.join(rootDir, candidate);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const withoutTitle = content.replace(/^#.*\n+/, "");
    const paragraph = withoutTitle.split(/\n\s*\n/)[0];
    if (paragraph && paragraph.trim().length > 0) return paragraph.trim().replace(/\s+/g, " ");
  }
  return null;
}

/** Route and component names are often the most honest description of a
 * product available — "FleetDashboard", "InvoiceList", "SettingsBilling"
 * says more than most package.json descriptions. We extract capitalized
 * word boundaries from route file/component names as coarse entity hints
 * (e.g. "FleetDashboard" -> "Fleet", "Dashboard"). */
function extractEntityHints(components: ComponentInfo[]): string[] {
  const words = new Set<string>();
  for (const c of components) {
    if (!c.isRoute && !c.isPrimitive) continue;
    if (c.isPrimitive) continue;
    const parts = c.name.match(/[A-Z][a-z0-9]*/g) ?? [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (!["page", "route", "index", "default", "component", "app"].includes(lower)) {
        words.add(part);
      }
    }
  }
  return [...words].sort();
}

/**
 * Produce a short, human-readable product brief this engine's design
 * direction is chosen against. This is deliberately NOT an AI call — the
 * MCP server hands facts to the host agent, and the host agent (which has
 * the model) does the actual interpreting and direction picking. This
 * function's job is just to gather the facts honestly.
 */
export function inferProductBrief(rootDir: string, components: ComponentInfo[]): ProductBrief {
  const pkg = readPackageJson(rootDir);
  const name: string | null = pkg?.name ?? null;
  const description: string | null = pkg?.description ?? null;
  const readmeSummary = firstReadmeParagraph(rootDir);
  const routeNames = components.filter((c) => c.isRoute).map((c) => c.name).sort();
  const entityHints = extractEntityHints(components);

  const parts: string[] = [];
  if (description) parts.push(description);
  else if (readmeSummary) parts.push(readmeSummary);
  else if (name) parts.push(`A project named "${name}".`);

  if (routeNames.length > 0) {
    parts.push(`Routes found: ${routeNames.join(", ")}.`);
  }
  if (entityHints.length > 0) {
    parts.push(`Recurring concepts in the code: ${entityHints.slice(0, 8).join(", ")}.`);
  }

  const totalInteractive = components.reduce((sum, c) => sum + c.roleCounts.interactive, 0);
  const totalElements = components.reduce(
    (sum, c) => sum + Object.values(c.roleCounts).reduce((a, b) => a + b, 0),
    0
  );
  if (totalElements > 0) {
    const density = totalInteractive / totalElements;
    parts.push(
      density > 0.25
        ? "Interaction-dense — likely a working tool rather than a marketing surface."
        : "Mostly presentational content relative to interactive controls."
    );
  }

  return {
    name,
    description,
    readmeSummary,
    routeNames,
    entityHints,
    brief: parts.join(" ") || "Not enough signal to infer the product yet.",
  };
}
