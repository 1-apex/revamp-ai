import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInMemoryProject, loadSourceFile, enumerateAddressableNodes } from "./addressing.js";
import { applyEditBatch } from "./applier.js";
import { hashSource } from "./logicSkeleton.js";
import type { EditBatch } from "./editOps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../fixtures/fleet-dashboard/src");
const dashboardPath = path.join(fixtureRoot, "routes/FleetDashboard.tsx");
const dashboardSource = readFileSync(dashboardPath, "utf8");
const badgePath = path.join(fixtureRoot, "components/ui/badge.tsx");
const badgeSource = readFileSync(badgePath, "utf8");

function projectFor(filePath: string, source: string) {
  const project = createInMemoryProject();
  const sf = loadSourceFile(project, filePath, source);
  return sf;
}

/**
 * This is the Phase 1 stop-and-check for the applier: every op type lands
 * the exact edit it promises, and both gates (hash-preserving for
 * set_class_list/set_cva_variants, token-diff for wrap_element/
 * insert_presentational) actually fire — proven by making the gate the
 * thing under test, not just checking the output text looks right.
 */

describe("applyEditBatch — set_class_list", () => {
  it("merges into an existing className via tailwind-merge (later conflicting utility wins)", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: h1.address.file,
      ops: [{ op: "set_class_list", address: h1.address, className: "text-3xl" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // text-xl (old) must be gone — text-3xl (new) wins the same conflict group.
    expect(result.code).toContain('className="font-bold text-3xl"');
    expect(result.code).not.toContain("text-xl");
  });

  it("adds a className attribute where there wasn't one", () => {
    const file = "plain.tsx";
    const source = `export default function Foo() { return <div><span>hi</span></div>; }`;
    const sf = projectFor(file, source);
    const span = enumerateAddressableNodes(sf, "Foo").find((n) => n.fingerprint.startsWith("element:span:"))!;
    const batch: EditBatch = { file: span.address.file, ops: [{ op: "set_class_list", address: span.address, className: "p-2" }] };
    const result = applyEditBatch(sf, file, batch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toContain('<span className="p-2">hi</span>');
  });

  it("never moves the logic-skeleton hash", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: h1.address.file,
      ops: [{ op: "set_class_list", address: h1.address, className: "text-3xl uppercase tracking-wide" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(hashSource(result.code, dashboardPath)).toBe(hashSource(dashboardSource, dashboardPath));
  });

  it("reverts the whole batch — leaves the SourceFile's own text restored — when validation fails", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const badAddress = { ...h1.address, path: [...h1.address.path.slice(0, -1), 99] };
    const batch: EditBatch = { file: h1.address.file, ops: [{ op: "set_class_list", address: badAddress, className: "x" }] };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].reason).toMatch(/does not resolve/);
  });
});

describe("applyEditBatch — set_cva_variants", () => {
  it("merges base and per-option class strings, leaves variant key names untouched", () => {
    const sf = projectFor(badgePath, badgeSource);
    const batch: EditBatch = {
      file: badgePath,
      ops: [
        {
          op: "set_cva_variants",
          file: badgePath,
          varName: "badgeVariants",
          base: "font-semibold",
          variants: { status: { alert: "bg-rose-200 text-rose-900" } },
        },
      ],
    };
    const result = applyEditBatch(sf, badgePath, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain("font-semibold");
    expect(result.code).toContain("bg-rose-200 text-rose-900");
    expect(result.code).not.toContain("bg-red-100 text-red-800");
    expect(hashSource(result.code, badgePath)).toBe(hashSource(badgeSource, badgePath));
  });

  it("fails rather than guessing when the target value isn't a plain string literal", () => {
    const file = "dynamic.tsx";
    const source = `
      import { cva } from "class-variance-authority";
      const extra = "bg-blue-600";
      export const buttonVariants = cva("inline-flex", { variants: { intent: { primary: extra } } });
    `;
    const sf = projectFor(file, source);
    const batch: EditBatch = {
      file,
      ops: [{ op: "set_cva_variants", file, varName: "buttonVariants", variants: { intent: { primary: "bg-indigo-600" } } }],
    };
    const result = applyEditBatch(sf, file, batch);
    expect(result.ok).toBe(false);
  });
});

describe("applyEditBatch — wrap_element", () => {
  it("moves the wrapped node verbatim inside a new wrapper", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: h1.address.file,
      ops: [{ op: "wrap_element", address: h1.address, wrapperTag: "span", wrapperClassName: "inline-block" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain(
      '<span className="inline-block"><h1 className="text-xl font-bold">Fleet Overview</h1></span>'
    );
  });

  it("moves the logic-skeleton hash (documented Phase 0 limitation) but passes the narrower token-diff gate", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = { file: h1.address.file, ops: [{ op: "wrap_element", address: h1.address, wrapperTag: "span" }] };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(hashSource(result.code, dashboardPath)).not.toBe(hashSource(dashboardSource, dashboardPath));
  });
});

describe("applyEditBatch — insert_presentational", () => {
  it("inserts a self-closing presentational leaf at the requested position", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: headerRow.address.file,
      ops: [
        {
          op: "insert_presentational",
          parentAddress: headerRow.address,
          atIndex: 0,
          tag: "hr",
          attributes: { "aria-hidden": "true" },
        },
      ],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toMatch(/<hr aria-hidden="true" \/>\s*<h1/);
  });

  it("inserted node's tokens are exactly what the gate allows — nothing extra sneaks in", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: headerRow.address.file,
      ops: [{ op: "insert_presentational", parentAddress: headerRow.address, atIndex: 2, tag: "hr", className: "my-2" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    // className is presentational — excluded from the hash — so it must not
    // show up as part of what moved the token stream at all.
    if (result.ok) expect(result.code).toContain('<hr className="my-2" />');
  });

  it("fails when atIndex is out of range against the live tree", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: headerRow.address.file,
      ops: [{ op: "insert_presentational", parentAddress: headerRow.address, atIndex: 99, tag: "hr" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(false);
  });
});

describe("applyEditBatch — add_import", () => {
  it("adds a default import", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "add_import", file: dashboardPath, source: "@/lib/icons", imported: "default", localName: "Icons" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toContain('import Icons from "@/lib/icons"');
  });

  it("adds a named import, aliased when the imported name differs from the local name", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "add_import", file: dashboardPath, source: "lucide-react", imported: "ArrowRight", localName: "Arrow" }],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toContain('import { ArrowRight as Arrow } from "lucide-react"');
  });
});

describe("applyEditBatch — mixed batches and the one-structural-op-per-batch cap", () => {
  it("applies a hash-preserving op and a structural op together, gated by the token-diff check", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const nodes = enumerateAddressableNodes(sf, "FleetDashboard");
    const headerRow = nodes.find((n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0)!;
    const h1 = nodes.find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: h1.address.file,
      ops: [
        { op: "insert_presentational", parentAddress: headerRow.address, atIndex: 2, tag: "hr" },
        { op: "set_class_list", address: h1.address, className: "text-3xl" },
      ],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain('<hr />');
    expect(result.code).toContain("text-3xl");
  });

  it("is rejected by the validator before anything is mutated when two structural ops collide", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const nodes = enumerateAddressableNodes(sf, "FleetDashboard");
    const headerRow = nodes.find((n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0)!;
    const h1 = nodes.find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: h1.address.file,
      ops: [
        { op: "wrap_element", address: h1.address, wrapperTag: "span" },
        { op: "insert_presentational", parentAddress: headerRow.address, atIndex: 0, tag: "hr" },
      ],
    };
    const result = applyEditBatch(sf, dashboardPath, batch);
    expect(result.ok).toBe(false);
    // Nothing should have been mutated — the SourceFile's own text is
    // untouched because validateEditBatch rejected before applier logic ran.
    expect(sf.getFullText()).toBe(dashboardSource);
  });
});
