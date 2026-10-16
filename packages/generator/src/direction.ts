import type { ProjectScan } from "@revamp/core";

/**
 * A design direction, deliberately this small. Every field maps directly
 * onto something a `set_class_list`/`set_cva_variants` op can actually
 * express — there is no field here for anything that would require a new
 * Tailwind theme token, because no edit op can touch the theme file (see
 * `.claude/skills/revamp/reference-design-direction.md`, which this
 * generator's whole approach is the deterministic sibling of). A type
 * scale and a spacing rhythm are part of that doc's heuristic too, but
 * applying them generically needs to know what ROLE an element plays
 * (a page title vs. a body paragraph) — a judgment call this v1
 * deliberately leaves to the AI-driven skill rather than guessing from
 * tag name alone. Color and radius don't need that judgment: a color
 * utility's CURRENT shade number already encodes the contrast decision a
 * human made, so re-hueing at the same shade preserves it; a radius value
 * is a single, context-free choice.
 */
export interface DesignDirection {
  name: string;
  /** Replaces any neutral-family color utility (slate/gray/zinc/neutral/stone). */
  neutral: string;
  /** Replaces any "accent-ish" color utility — anything not neutral and not danger. */
  primary: string;
  /** Replaces a danger-ish color utility (red/rose). */
  danger: string;
  /** The one canonical non-"full" radius utility this direction uses everywhere. */
  radius: string;
}

export const NEUTRAL_FAMILIES = ["slate", "gray", "zinc", "neutral", "stone"] as const;
export const DANGER_FAMILIES = ["red", "rose"] as const;

/**
 * Three presets, not an unbounded palette space. Picking from a small,
 * named, pre-vetted set is what keeps `pickDirection` deterministic and
 * testable (same brief text → same preset, always) while still being a
 * real decision, not a hardcoded constant — the same reasoning
 * `editOps.ts`'s fixed allowlists use for wrapper tags and import
 * sources: small and auditable beats open-ended and unpredictable.
 */
export const PRESETS: readonly DesignDirection[] = [
  { name: "operational", neutral: "slate", primary: "blue", danger: "rose", radius: "rounded-lg" },
  { name: "consumer", neutral: "zinc", primary: "indigo", danger: "red", radius: "rounded-xl" },
  { name: "calm", neutral: "stone", primary: "teal", danger: "red", radius: "rounded-md" },
] as const;

const OPERATIONAL_SIGNAL = /dashboard|admin|internal|ops\b|logistics|inventory|fleet|warehouse|console|panel/i;
const CONSUMER_SIGNAL = /consumer|shop|store|social|marketplace|customer-facing|storefront/i;

/**
 * Deterministic: the same `ProjectScan` always picks the same preset.
 * Checks the product brief for the same operational-vs-consumer signals
 * `reference-design-direction.md` names as a starting point for a human
 * (or an LLM) making this call by hand — this is that same first step,
 * made mechanical. Falls through to "calm" when neither signal matches,
 * a genuine third option rather than reusing "operational" as both a
 * matched case and the default (which would make the fallback
 * meaningless as a choice).
 */
export function pickDirection(scan: ProjectScan): DesignDirection {
  const brief = scan.productBrief.brief;
  if (OPERATIONAL_SIGNAL.test(brief)) return PRESETS[0]!;
  if (CONSUMER_SIGNAL.test(brief)) return PRESETS[1]!;
  return PRESETS[2]!;
}
