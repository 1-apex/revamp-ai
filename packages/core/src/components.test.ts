import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanAllComponents, scanComponentsInFile } from "./components.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../fixtures/fleet-dashboard/src");
const buttonPath = path.join(fixtureRoot, "components/ui/button.tsx");

/** Writes `source` to a throwaway file so `scanComponentsInFile` (which
 * always reads from disk) can be exercised against a case the shared
 * fixture doesn't cover, without adding a fixture file for one edge case. */
function scanInlineSource(source: string): ReturnType<typeof scanComponentsInFile> {
  const dir = mkdtempSync(path.join(tmpdir(), "revamp-core-test-"));
  const file = path.join(dir, "inline.tsx");
  writeFileSync(file, source);
  return scanComponentsInFile(file, dir);
}

/**
 * This package's first test file. Added alongside the `unwrapComponentFunction`
 * fix (Phase 2) specifically to pin down the bug it fixes: `Button` — the
 * fixture's own `React.forwardRef<...>((props, ref) => {...})` component —
 * was entirely invisible to `scanAllComponents` before, not found as a
 * primitive, not fingerprinted, nothing. See docs/phase-2-* for the full
 * story of how this was found (it wasn't hypothetical — `revamp scan`
 * against this project's own existing fixture showed 5 primitives where
 * there have always been 6).
 */
describe("scanComponentsInFile — forwardRef-wrapped components", () => {
  it("finds a React.forwardRef((props, ref) => ...) component in the real fixture", () => {
    const found = scanComponentsInFile(buttonPath, fixtureRoot);
    const button = found.find((c) => c.name === "Button");
    expect(button).toBeDefined();
    expect(button!.jsxTagsUsed).toContain("button");
  });

  it("finds a doubly-wrapped memo(forwardRef(...)) component", () => {
    const found = scanInlineSource(`
      import * as React from "react";
      export const IconButton = React.memo(React.forwardRef((props, ref) => {
        return <button ref={ref}><svg/></button>;
      }));
    `);
    const comp = found.find((c) => c.name === "IconButton");
    expect(comp).toBeDefined();
    expect(comp!.jsxTagsUsed).toEqual(["button", "svg"]);
  });

  it("does not treat a bare forwardRef(...) assigned to a lowercase name as a component", () => {
    const found = scanInlineSource(`
      import * as React from "react";
      const helper = React.forwardRef((props, ref) => <div/>);
    `);
    expect(found).toEqual([]);
  });

  it("does not unwrap an arbitrary call — only the forwardRef/memo allowlist", () => {
    const found = scanInlineSource(`
      export const Foo = withSomething((props) => <div>{props.x}</div>);
    `);
    expect(found).toEqual([]);
  });
});

describe("scanAllComponents — the real fixture", () => {
  it("finds all seven components: one route, six shadcn primitives (Button included)", () => {
    const found = scanAllComponents(fixtureRoot);
    const names = found.map((c) => c.name).sort();
    expect(names).toEqual(["Badge", "Button", "Card", "CardContent", "CardHeader", "CardTitle", "FleetDashboard"].sort());
    expect(found.filter((c) => c.isPrimitive)).toHaveLength(6);
    expect(found.filter((c) => c.isRoute)).toHaveLength(1);
  });
});
