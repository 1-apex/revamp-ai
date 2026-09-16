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
