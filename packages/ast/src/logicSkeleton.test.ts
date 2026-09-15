import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import prettier from "prettier";
import { extractLogicSkeleton, hashSource } from "./logicSkeleton.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../fixtures/fleet-dashboard/src");
const dashboardPath = path.join(fixtureRoot, "routes/FleetDashboard.tsx");
const dashboardSource = readFileSync(dashboardPath, "utf8");

/**
 * These three tests ARE the Phase 0 stop-and-check from the build order:
 * formatting must never move the hash, a real logic change always must.
 * If any of these ever goes red, do not "fix the test" — the hash is wrong.
 */
describe("logic-skeleton hash — the safety guarantee", () => {
  it("does not move when Prettier reformats with the default config", async () => {
    const before = hashSource(dashboardSource, dashboardPath);
    const reformatted = await prettier.format(dashboardSource, {
      parser: "typescript",
      semi: true,
      singleQuote: false,
    });
    const after = hashSource(reformatted, dashboardPath);
    expect(after).toBe(before);
  });

  it("does not move when Prettier reformats with a very different style", async () => {
    const before = hashSource(dashboardSource, dashboardPath);
    const reformatted = await prettier.format(dashboardSource, {
      parser: "typescript",
      semi: false,
      singleQuote: true,
      printWidth: 40,
      tabWidth: 4,
    });
    const after = hashSource(reformatted, dashboardPath);
    expect(after).toBe(before);
  });

  it("does not move when only className values change", () => {
    const before = hashSource(dashboardSource, dashboardPath);
    const restyled = dashboardSource
      .replaceAll('className="p-6 space-y-4"', 'className="p-10 grid gap-6 bg-slate-950"')
      .replaceAll('className="text-xl font-bold"', 'className="text-3xl font-black tracking-tight"')
      .replaceAll("grid-cols-3 gap-4", "grid-cols-2 gap-8");
    expect(restyled).not.toBe(dashboardSource); // sanity: the edit actually happened
    const after = hashSource(restyled, dashboardPath);
    expect(after).toBe(before);
  });

  it("changes when an event handler's target function changes", () => {
    const before = hashSource(dashboardSource, dashboardPath);
    // Simulates exactly the bug class this hash exists to catch: an edit
    // that silently rewires behavior instead of appearance.
    const rewired = dashboardSource.replace(
      "<Button onClick={handleRefresh}>Refresh</Button>",
      "<Button onClick={() => setFilter('all')}>Refresh</Button>"
    );
    expect(rewired).not.toBe(dashboardSource);
    const after = hashSource(rewired, dashboardPath);
    expect(after).not.toBe(before);
  });

  it("changes when a hook's dependency array changes", () => {
    const before = hashSource(dashboardSource, dashboardPath);
    const mutated = dashboardSource.replace(
      "}, [vehicles, filter]);",
      "}, [vehicles]);"
    );
    expect(mutated).not.toBe(dashboardSource);
    const after = hashSource(mutated, dashboardPath);
    expect(after).not.toBe(before);
  });

  it("changes when hook call order changes", () => {
    const before = hashSource(dashboardSource, dashboardPath);
    // swap the declaration order of two independent hooks
    const swapped = dashboardSource.replace(
      `const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<"all" | Vehicle["status"]>("all");`,
      `const [filter, setFilter] = React.useState<"all" | Vehicle["status"]>("all");
  const [error, setError] = React.useState<string | null>(null);`
    );
    expect(swapped).not.toBe(dashboardSource);
    const after = hashSource(swapped, dashboardPath);
    expect(after).not.toBe(before);
  });

  it("is stable across two runs on the same input (determinism)", () => {
    const a = hashSource(dashboardSource, dashboardPath);
    const b = hashSource(dashboardSource, dashboardPath);
    expect(a).toBe(b);
  });

  it("exposes the token stream for debugging a mismatch", () => {
    const { tokens, hash } = extractLogicSkeleton(dashboardSource, dashboardPath);
    expect(tokens.length).toBeGreaterThan(10);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
