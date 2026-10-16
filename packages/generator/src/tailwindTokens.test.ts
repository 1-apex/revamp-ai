import { describe, it, expect } from "vitest";
import { remapToken, remapClassName } from "./tailwindTokens.js";
import type { DesignDirection } from "./direction.js";

const direction: DesignDirection = { name: "test", neutral: "zinc", primary: "teal", danger: "rose", radius: "rounded-lg" };

describe("remapToken", () => {
  it("re-hues a neutral-family color utility to the direction's neutral family, same prefix and shade", () => {
    expect(remapToken("text-slate-700", direction)).toBe("text-zinc-700");
    expect(remapToken("bg-gray-100", direction)).toBe("bg-zinc-100");
  });

  it("re-hues an accent-ish color utility to the direction's primary family", () => {
    expect(remapToken("bg-blue-600", direction)).toBe("bg-teal-600");
    expect(remapToken("text-emerald-800", direction)).toBe("text-teal-800");
  });

  it("re-hues a danger-family color utility to the direction's danger family", () => {
    expect(remapToken("bg-red-100", direction)).toBe("bg-rose-100");
    expect(remapToken("text-red-800", direction)).toBe("text-rose-800");
  });

  it("returns undefined when the token already matches the direction (no-op, not a same-value replacement)", () => {
    expect(remapToken("bg-teal-600", direction)).toBeUndefined();
    expect(remapToken("text-rose-800", direction)).toBeUndefined();
  });

  it("normalizes a non-full radius utility to the direction's canonical radius", () => {
    expect(remapToken("rounded-sm", direction)).toBe("rounded-lg");
    expect(remapToken("rounded", direction)).toBe("rounded-lg");
    expect(remapToken("rounded-2xl", direction)).toBe("rounded-lg");
  });

  it("never touches rounded-full — a shape choice, not a styling knob", () => {
    expect(remapToken("rounded-full", direction)).toBeUndefined();
  });

  it("returns undefined for a radius token that already equals the direction's radius", () => {
    expect(remapToken("rounded-lg", direction)).toBeUndefined();
  });

  it("leaves layout/spacing utilities alone — out of v1 scope, not guessed at", () => {
    expect(remapToken("flex", direction)).toBeUndefined();
    expect(remapToken("items-center", direction)).toBeUndefined();
    expect(remapToken("gap-4", direction)).toBeUndefined();
    expect(remapToken("p-6", direction)).toBeUndefined();
    expect(remapToken("text-sm", direction)).toBeUndefined();
  });

  it("leaves an arbitrary-value color/radius alone — doesn't match the known shape", () => {
    expect(remapToken("bg-[#1d4ed8]", direction)).toBeUndefined();
    expect(remapToken("rounded-[12px]", direction)).toBeUndefined();
  });

  it("leaves a variant-prefixed utility alone — a documented v1 limitation, not an oversight (the real fixture's Button has hover:bg-slate-800)", () => {
    expect(remapToken("hover:bg-slate-800", direction)).toBeUndefined();
    expect(remapToken("focus:ring-2", direction)).toBeUndefined();
    expect(remapToken("dark:bg-zinc-900", direction)).toBeUndefined();
  });
});

describe("remapClassName", () => {
  it("returns only the tokens that actually change, deduplicated", () => {
    const result = remapClassName("flex items-center bg-blue-600 bg-blue-600 text-white rounded-md", direction);
    expect(result.sort()).toEqual(["bg-teal-600", "rounded-lg"].sort());
  });

  it("returns an empty array when nothing in the className needs to change", () => {
    expect(remapClassName("flex items-center gap-2 p-4", direction)).toEqual([]);
    expect(remapClassName("bg-teal-600 rounded-lg", direction)).toEqual([]);
  });
});
