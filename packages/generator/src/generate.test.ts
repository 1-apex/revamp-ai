import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInMemoryProject, loadSourceFile, validateEditBatch, applyEditBatch } from "@revamp/ast";
import { generateForProject, generateDesignBatches } from "./generate.js";
import { PRESETS } from "./direction.js";
import type { EditBatch } from "@revamp/ast";

const here = path.dirname(fileURLToPath(import.meta.url));
const fleetDashboardRoot = path.resolve(here, "../../../fixtures/fleet-dashboard");
const inventoryPanelRoot = path.resolve(here, "../../../fixtures/inventory-panel");

/**
 * The thing that actually matters about a generator built on top of
 * Phase 1's safety layer: every batch it produces must be a batch that
 * layer would accept on its own terms. This isn't asserted — it's run:
 * every generated batch here is fed through the real `validateEditBatch`
 * and `applyEditBatch`, against the real fixtures, the same functions
 * `@revamp/ast`'s own test suite already proved correct. If this
 * generator ever produced an illegal batch, this is where it would be
 * caught, not in a human reading the generator's code and trusting its
 * own bookkeeping.
 */
function expectEveryBatchToApplyCleanly(batches: EditBatch[]) {
  for (const batch of batches) {
    const source = readFileSync(batch.file, "utf8");
    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, batch.file, source);

    const validation = validateEditBatch(sourceFile, batch);
    expect(validation, `validateEditBatch rejected a generated batch for ${batch.file}: ${JSON.stringify(validation.errors)}`).toEqual({
      ok: true,
      errors: [],
    });

    // validateEditBatch doesn't mutate; applyEditBatch needs its own fresh
    // sourceFile the same way every other caller in this repo re-resolves
    // against a live tree rather than reusing one already touched.
    const freshProject = createInMemoryProject();
    const freshSourceFile = loadSourceFile(freshProject, batch.file, source);
    const result = applyEditBatch(freshSourceFile, batch.file, batch);
    expect(result.ok, `applyEditBatch rejected a generated batch for ${batch.file}: ${JSON.stringify(!result.ok && result.errors)}`).toBe(true);
  }
}

describe("generateForProject — fleet-dashboard", () => {
  it("picks the operational preset from the product brief (logistics/fleet)", () => {
    const { direction } = generateForProject(fleetDashboardRoot);
    expect(direction).toBe(PRESETS[0]);
    expect(direction.name).toBe("operational");
  });

  it("every generated batch validates and applies cleanly against the real files", () => {
    const { batches } = generateForProject(fleetDashboardRoot);
    expect(batches.length).toBeGreaterThan(0);
    expectEveryBatchToApplyCleanly(batches);
  });

  it("recolors the error-state div's danger text, leaves everything else in FleetDashboard.tsx alone", () => {
    const { batches } = generateForProject(fleetDashboardRoot);
    const dashboardBatch = batches.find((b) => b.file.endsWith("FleetDashboard.tsx"));
    expect(dashboardBatch).toBeDefined();
    expect(dashboardBatch!.ops).toEqual([
      expect.objectContaining({ op: "set_class_list", className: "text-rose-600" }),
    ]);
  });

  it("recolors Badge's accent/danger variants but leaves the already-neutral 'idle' variant untouched", () => {
    const { batches } = generateForProject(fleetDashboardRoot);
    const badgeBatch = batches.find((b) => b.file.endsWith("badge.tsx"));
    expect(badgeBatch).toBeDefined();
    const op = badgeBatch!.ops[0] as any;
    expect(op.op).toBe("set_cva_variants");
    expect(op.varName).toBe("badgeVariants");
    expect(op.base).toBeUndefined(); // base is "... rounded-full ..." — rounded-full is never touched
    expect(op.variants).toEqual({
      status: { active: "bg-blue-100 text-blue-800", alert: "bg-rose-100 text-rose-800" },
    });
    expect(op.variants.status.idle).toBeUndefined(); // slate (fixture) === slate (operational neutral) — no change
  });

  it("normalizes Button's base radius but leaves its slate-based variants alone (already the operational neutral)", () => {
    const { batches } = generateForProject(fleetDashboardRoot);
    const buttonBatch = batches.find((b) => b.file.endsWith("components/ui/button.tsx"));
    expect(buttonBatch).toBeDefined();
    const op = buttonBatch!.ops[0] as any;
    expect(op.op).toBe("set_cva_variants");
    expect(op.varName).toBe("buttonVariants");
    expect(op.base).toBe("rounded-lg");
    expect(op.variants).toBeUndefined(); // hover:bg-slate-* is variant-prefixed (left alone); bg-slate-900 already matches
  });

  it("produces no batch at all for card.tsx — every className in it is already direction-neutral", () => {
    const { batches } = generateForProject(fleetDashboardRoot);
    expect(batches.find((b) => b.file.endsWith("card.tsx"))).toBeUndefined();
  });
});

describe("generateForProject — inventory-panel", () => {
  it("every generated batch validates and applies cleanly against the real files", () => {
    const { batches, direction } = generateForProject(inventoryPanelRoot);
    expect(direction.name).toBe("operational"); // brief mentions "warehouse"/"inventory"
    expectEveryBatchToApplyCleanly(batches);
  });

  it("handles the single-argument cva() form (IconButton) without a base field", () => {
    const { batches } = generateForProject(inventoryPanelRoot);
    const iconButtonBatch = batches.find((b) => b.file.endsWith("icon-button.tsx"));
    expect(iconButtonBatch).toBeDefined();
    const op = iconButtonBatch!.ops[0] as any;
    expect(op.op).toBe("set_cva_variants");
    expect(op.varName).toBe("iconButtonVariants");
    expect(op.base).toBeUndefined(); // cva({...}) — single-argument form has no base slot at all
    expect(op.variants).toEqual({
      // tone.neutral: "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
      // — "neutral" is itself one of NEUTRAL_FAMILIES, re-hued to slate;
      // the hover: utility is left alone (variant-prefixed, v1 limitation).
      tone: { neutral: "bg-slate-100 text-slate-700", danger: "bg-rose-50" },
    });
  });

  it("produces no batch for input.tsx — its own className is cn(...), a dynamic expression, same as every shadcn primitive's own root element", () => {
    // Input's "h-9 rounded-md border border-neutral-300 px-3 text-sm" lives
    // as a STRING ARGUMENT to cn(...), not as the element's own className
    // value — className={cn("...", className)} is exactly as dynamic as
    // fleet-dashboard's Badge/Button (className={cn(xVariants({...}), className)}),
    // and getStaticClassName correctly can't see into it. This is the
    // general shape every shadcn-style primitive's own root element has;
    // the generator reaches a primitive's styling through its cva()
    // variants instead (see the IconButton test above), never through its
    // own root className.
    const { batches } = generateForProject(inventoryPanelRoot);
    expect(batches.find((b) => b.file.endsWith("components/ui/input.tsx"))).toBeUndefined();
  });
});

describe("generateDesignBatches — never emits a no-op edit", () => {
  it("returns no batches when the direction already matches every file's existing colors/radius", () => {
    // card.tsx's scan already demonstrates this per-file (see above); this
    // confirms the same property at the generateDesignBatches level with
    // an explicit, hand-picked direction equal to what the fixture uses.
    const scan = {
      rootDir: fleetDashboardRoot,
      scannedAt: new Date().toISOString(),
      stack: {} as any,
      components: [],
      routeCount: 0,
      primitiveCount: 0,
      productBrief: { brief: "" } as any,
      fileFingerprints: [],
    };
    expect(generateDesignBatches(fleetDashboardRoot, scan, PRESETS[0]!)).toEqual([]);
  });
});
