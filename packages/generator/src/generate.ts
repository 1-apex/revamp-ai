import { readFileSync } from "node:fs";
import { Node } from "ts-morph";
import {
  createInMemoryProject,
  loadSourceFile,
  enumerateAddressableNodes,
  getStaticClassName,
  findAllCvaCalls,
  cvaVariantKeys,
  getVariantOptionInitializer,
  type EditBatch,
  type EditOp,
} from "@revamp/ast";
import { scanProject, type ProjectScan } from "@revamp/core";
import { pickDirection, type DesignDirection } from "./direction.js";
import { remapClassName } from "./tailwindTokens.js";

/**
 * One batch per file that has at least one change, built from the same
 * primitives every other phase already proved correct:
 * `enumerateAddressableNodes` for JSX elements, `findAllCvaCalls` for
 * `cva()` calls, `remapClassName` (this package's own, v1-scoped logic)
 * to decide what, if anything, changes. Produces ordinary `EditBatch`
 * values — nothing here bypasses validation; every batch this returns
 * still has to pass `validateEditBatch`/`applyEditBatch` like any other,
 * which `generate.test.ts` checks directly rather than trusting this
 * function's own bookkeeping.
 */
export function generateDesignBatches(rootDir: string, scan: ProjectScan, direction: DesignDirection): EditBatch[] {
  const batches: EditBatch[] = [];
  const files = [...new Set(scan.components.map((c) => c.file))];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, file, source);
    const ops: EditOp[] = [];

    const componentsInFile = scan.components.filter((c) => c.file === file);
    for (const component of componentsInFile) {
      for (const node of enumerateAddressableNodes(sourceFile, component.name)) {
        const className = getStaticClassName(node.node);
        if (!className) continue; // absent or dynamic — nothing this generator can safely touch
        const newTokens = remapClassName(className, direction);
        if (newTokens.length === 0) continue; // nothing to change — don't emit a no-op edit
        ops.push({ op: "set_class_list", address: node.address, className: newTokens.join(" ") });
      }
    }

    for (const { varName, info } of findAllCvaCalls(sourceFile)) {
      let base: string | undefined;
      if (info.baseArg && Node.isStringLiteral(info.baseArg)) {
        const newTokens = remapClassName(info.baseArg.getLiteralValue(), direction);
        if (newTokens.length > 0) base = newTokens.join(" ");
      }

      const variants: Record<string, Record<string, string>> = {};
      for (const [group, options] of Object.entries(cvaVariantKeys(info))) {
        for (const option of options) {
          const valueNode = getVariantOptionInitializer(info, group, option);
          if (!valueNode || !Node.isStringLiteral(valueNode)) continue; // dynamic value — leave it alone
          const newTokens = remapClassName(valueNode.getLiteralValue(), direction);
          if (newTokens.length === 0) continue;
          (variants[group] ??= {})[option] = newTokens.join(" ");
        }
      }

      if (base !== undefined || Object.keys(variants).length > 0) {
        ops.push({
          op: "set_cva_variants",
          file,
          varName,
          ...(base !== undefined ? { base } : {}),
          ...(Object.keys(variants).length > 0 ? { variants } : {}),
        });
      }
    }

    if (ops.length > 0) batches.push({ file, ops });
  }

  return batches;
}

export interface GeneratedPlan {
  direction: DesignDirection;
  scan: ProjectScan;
  batches: EditBatch[];
}

/** The one-call convenience the CLI uses: scan, pick a direction, generate
 * — in one place, so `revamp generate` and anything else that wants "the
 * whole pipeline" don't each re-order these three steps independently. */
export function generateForProject(rootDir: string): GeneratedPlan {
  const scan = scanProject(rootDir);
  const direction = pickDirection(scan);
  const batches = generateDesignBatches(rootDir, scan, direction);
  return { direction, scan, batches };
}
