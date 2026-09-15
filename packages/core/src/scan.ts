import path from "node:path";
import { readFileSync } from "node:fs";
import { hashSource } from "@revamp/ast";
import { detectStack, type StackInfo } from "./stack.js";
import { scanAllComponents, type ComponentInfo } from "./components.js";
import { inferProductBrief, type ProductBrief } from "./productBrief.js";

export interface FileFingerprint {
  relativePath: string;
  hash: string;
}

export interface ProjectScan {
  rootDir: string;
  scannedAt: string;
  stack: StackInfo;
  components: ComponentInfo[];
  routeCount: number;
  primitiveCount: number;
  productBrief: ProductBrief;
  fileFingerprints: FileFingerprint[];
}

/**
 * The single entry point for Phase 0: read a project, say what it is, and
 * fingerprint it. Nothing here writes anything — scanning is always safe
 * to run, any number of times, on any repo.
 */
export function scanProject(rootDir: string): ProjectScan {
  const stack = detectStack(rootDir);
  const components = scanAllComponents(rootDir);
  const productBrief = inferProductBrief(rootDir, components);

  const fileFingerprints: FileFingerprint[] = [];
  const seenFiles = new Set(components.map((c) => c.file));
  for (const file of seenFiles) {
    const source = readFileSync(file, "utf8");
    fileFingerprints.push({
      relativePath: path.relative(rootDir, file),
      hash: hashSource(source, file),
    });
  }
  fileFingerprints.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    rootDir,
    scannedAt: new Date().toISOString(),
    stack,
    components,
    routeCount: components.filter((c) => c.isRoute).length,
    primitiveCount: components.filter((c) => c.isPrimitive).length,
    productBrief,
    fileFingerprints,
  };
}
