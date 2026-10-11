import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createInMemoryProject,
  loadSourceFile,
  enumerateAddressableNodes,
  resolveAddress,
  addressKey,
  type AddressableNode,
  type EditAddress,
} from "./addressing.js";
import type { Project, SourceFile } from "ts-morph";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../fixtures/fleet-dashboard/src");
const dashboardPath = path.join(fixtureRoot, "routes/FleetDashboard.tsx");
const dashboardSource = readFileSync(dashboardPath, "utf8");
const buttonPath = path.join(fixtureRoot, "components/ui/button.tsx");
const buttonSource = readFileSync(buttonPath, "utf8");

const inventoryRoot = path.resolve(here, "../../../fixtures/inventory-panel/src");
const inventoryPanelPath = path.join(inventoryRoot, "pages/InventoryPanel.tsx");
const inventoryPanelSource = readFileSync(inventoryPanelPath, "utf8");
const iconButtonPath = path.join(inventoryRoot, "components/ui/icon-button.tsx");
const iconButtonSource = readFileSync(iconButtonPath, "utf8");

const FORBIDDEN_MAP_TAGS = ["Card", "CardHeader", "CardTitle", "CardContent", "Badge"];

/**
 * This is the Phase 1 stop-and-check for node addressing: a stable address
 * scheme that survives reformatting/restyling but aborts (never guesses)
 * the moment the file's structure has actually changed underneath it.
 */
describe("node addressing — enumeration", () => {
  let project: Project;
  let sf: SourceFile;
  let nodes: AddressableNode[];

  beforeAll(() => {
    project = createInMemoryProject();
    sf = loadSourceFile(project, dashboardPath, dashboardSource);
    nodes = enumerateAddressableNodes(sf, "FleetDashboard");
  });

  it("finds exactly the three JSX-yielding return points (error, loading, main content)", () => {
    const roots = new Set(nodes.map((n) => n.address.root));
    expect(roots.size).toBe(3);
    expect([...roots].sort()).toEqual([0, 1, 2]);
  });

  it("never enumerates JSX produced inside a .map() callback", () => {
    const leaked = nodes.filter((n) => FORBIDDEN_MAP_TAGS.some((tag) => n.fingerprint.includes(`element:${tag}:`)));
    expect(leaked).toEqual([]);
  });

  it("every enumerated address re-resolves against the same file with a matching fingerprint", () => {
    for (const n of nodes) {
      const result = resolveAddress(sf, n.address);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.fingerprint).toBe(n.fingerprint);
    }
  });
});

describe("node addressing — resolve-and-reverify against a changed file", () => {
  function resolveAgainstMutated(mutatedSource: string, address: EditAddress) {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, dashboardPath, mutatedSource);
    return resolveAddress(sf, address);
  }

  function baseline() {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, dashboardPath, dashboardSource);
    return enumerateAddressableNodes(sf, "FleetDashboard");
  }

  it("tolerates a presentational-only change (className) — fingerprint is unchanged", () => {
    const nodes = baseline();
    const h1 = nodes.find((n) => n.fingerprint.startsWith("element:h1:"))!;
    expect(h1).toBeDefined();

    const mutated = dashboardSource.replace(
      '<h1 className="text-xl font-bold">Fleet Overview</h1>',
      '<h1 className="text-3xl font-black tracking-tight uppercase">Fleet Overview</h1>'
    );
    expect(mutated).not.toBe(dashboardSource);

    const result = resolveAgainstMutated(mutated, h1.address);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fingerprint).toBe(h1.fingerprint);
  });

  it("detects a structural change (a child removed) — fingerprint changes", () => {
    const nodes = baseline();
    const headerRow = nodes.find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    expect(headerRow).toBeDefined();
    expect(headerRow.fingerprint).toBe("element:div:[]:children[element:h1,element:Button]");

    const mutated = dashboardSource.replace("<Button onClick={handleRefresh}>Refresh</Button>", "");
    expect(mutated).not.toBe(dashboardSource);

    const result = resolveAgainstMutated(mutated, headerRow.address);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fingerprint).not.toBe(headerRow.fingerprint);
  });

  it("aborts, rather than guessing, when the child index no longer exists", () => {
    const nodes = baseline();
    const h1 = nodes.find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const badAddress: EditAddress = { ...h1.address, path: [...h1.address.path.slice(0, -1), 99] };

    const result = resolveAgainstMutated(dashboardSource, badAddress);
    expect(result.ok).toBe(false);
  });

  it("aborts, rather than guessing, when the root index no longer exists", () => {
    const goneRootAddress: EditAddress = {
      file: dashboardPath,
      component: "FleetDashboard",
      root: 7,
      path: [],
    };
    const result = resolveAgainstMutated(dashboardSource, goneRootAddress);
    expect(result.ok).toBe(false);
  });

  it("aborts, rather than guessing, when the named component doesn't exist", () => {
    const result = resolveAgainstMutated(dashboardSource, {
      file: dashboardPath,
      component: "NotAComponent",
      root: 0,
      path: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe("addressKey", () => {
  it("produces a stable, human-readable string for an address", () => {
    const addr: EditAddress = { file: "a.tsx", component: "Foo", root: 1, path: [0, 2] };
    expect(addressKey(addr)).toBe("a.tsx::Foo::1::0.2");
  });
});

/**
 * `Button` in the real fixture is `React.forwardRef<HTMLButtonElement,
 * ButtonProps>((props, ref) => {...})` — the standard shadcn/ui shape, and
 * `findComponentFunction` could not see it at all before the
 * `unwrapComponentFunction` fix: a forwardRef-wrapped component's render
 * function sits inside a CallExpression argument, not directly in a
 * VariableDeclarator's `init`. Found while adding more fixtures for Phase
 * 2 and confirmed against this project's own existing fixture, not a
 * hypothetical — see docs/phase-2-* for the full writeup.
 */
describe("node addressing — forwardRef-wrapped components", () => {
  it("finds the JSX root inside a React.forwardRef(...) render function", () => {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, buttonPath, buttonSource);
    const nodes = enumerateAddressableNodes(sf, "Button");
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]!.fingerprint).toMatch(/^element:button:/);
  });

  it("re-resolves an address inside a forwardRef component the same way as any other", () => {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, buttonPath, buttonSource);
    const [button] = enumerateAddressableNodes(sf, "Button");
    const result = resolveAddress(sf, button!.address);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fingerprint).toBe(button!.fingerprint);
  });

  it("still aborts for a wrapper name outside the small allowlist (a custom HOC)", () => {
    const file = "wrapped.tsx";
    const source = `const Foo = withSomething((props) => <div>{props.x}</div>);`;
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, file, source);
    expect(enumerateAddressableNodes(sf, "Foo")).toEqual([]);
  });

  it("recurses through a doubly-wrapped React.memo(React.forwardRef(...)) component", () => {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, iconButtonPath, iconButtonSource);
    const nodes = enumerateAddressableNodes(sf, "IconButton");
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]!.fingerprint).toMatch(/^element:button:/);
  });
});

/**
 * The second fixture (`inventory-panel`) was added specifically to exercise
 * a named (non-default) export page component, and — the part this
 * describe block is about — JSX nested inside a ternary's branches rather
 * than only inside a `.map()` callback. `addressing.ts`'s own "positional
 * descendant of a component's own return value" scope cut already covers
 * this (a ternary's branches are JSX reached through a non-JSX
 * `ConditionalExpression`, the same shape of gap as `.map()`), but until
 * this fixture existed, nothing actually proved it — the only prior
 * evidence was the `.map()` case in `FleetDashboard`.
 */
describe("node addressing — JSX inside a ternary's branches (same scope cut as .map())", () => {
  it("finds InventoryPanel's single root (a named, non-default export)", () => {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, inventoryPanelPath, inventoryPanelSource);
    const nodes = enumerateAddressableNodes(sf, "InventoryPanel");
    const roots = new Set(nodes.map((n) => n.address.root));
    expect(roots).toEqual(new Set([0]));
  });

  it("never enumerates the <span>Loading…</span> or <ul> ternary branches", () => {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, inventoryPanelPath, inventoryPanelSource);
    const nodes = enumerateAddressableNodes(sf, "InventoryPanel");
    const leaked = nodes.filter(
      (n) => n.fingerprint.includes("element:ul:") || n.fingerprint.startsWith("element:span:")
    );
    expect(leaked).toEqual([]);
  });

  it("still enumerates the root-level search-row div, which sits before the ternary and is unaffected by it", () => {
    const project = createInMemoryProject();
    const sf = loadSourceFile(project, inventoryPanelPath, inventoryPanelSource);
    const nodes = enumerateAddressableNodes(sf, "InventoryPanel");
    const searchRow = nodes.find((n) => n.fingerprint.startsWith("element:div:") && n.address.path.length === 1);
    expect(searchRow).toBeDefined();
    expect(searchRow!.fingerprint).toBe("element:div:[]:children[element:Input,element:IconButton]");
  });
});
