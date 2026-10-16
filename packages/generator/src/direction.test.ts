import { describe, it, expect } from "vitest";
import { pickDirection, PRESETS } from "./direction.js";
import type { ProjectScan } from "@revamp/core";

function scanWithBrief(brief: string): ProjectScan {
  return {
    rootDir: "/x",
    scannedAt: new Date().toISOString(),
    stack: { reactVersion: null, buildTool: "unknown", tailwind: { present: false }, shadcn: { present: false }, packageManager: "unknown" } as any,
    components: [],
    routeCount: 0,
    primitiveCount: 0,
    productBrief: { brief, recurringConcepts: [], contentWeighting: "balanced" } as any,
    fileFingerprints: [],
  };
}

describe("pickDirection — deterministic, signal-based", () => {
  it("picks the operational preset for a dashboard/admin/fleet-style brief", () => {
    expect(pickDirection(scanWithBrief("Internal dashboard for logistics coordinators to track vehicle fleets."))).toBe(PRESETS[0]);
    expect(pickDirection(scanWithBrief("An admin console for warehouse inventory.")).name).toBe("operational");
  });

  it("picks the consumer preset for a shop/social/marketplace-style brief", () => {
    expect(pickDirection(scanWithBrief("A consumer-facing storefront for browsing products."))).toBe(PRESETS[1]);
    expect(pickDirection(scanWithBrief("A social marketplace app.")).name).toBe("consumer");
  });

  it("falls back to the third preset when neither signal matches — a real option, not a reused default", () => {
    const result = pickDirection(scanWithBrief("A tool for calculating tax brackets."));
    expect(result).toBe(PRESETS[2]);
    expect(result.name).not.toBe("operational");
  });

  it("is deterministic — the same brief always picks the same preset", () => {
    const scan = scanWithBrief("Internal dashboard for logistics.");
    const first = pickDirection(scan);
    const second = pickDirection(scan);
    expect(first).toBe(second);
  });

  it("checks operational signals before consumer ones when a brief could arguably match both", () => {
    // "internal" (operational) and "customer-facing" (consumer) both appear;
    // operational is checked first, so it should win — documents the
    // precedence rather than leaving it to read order coincidentally.
    const result = pickDirection(scanWithBrief("An internal admin panel for managing customer-facing orders."));
    expect(result.name).toBe("operational");
  });
});
