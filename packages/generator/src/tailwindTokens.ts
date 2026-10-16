import { NEUTRAL_FAMILIES, DANGER_FAMILIES, type DesignDirection } from "./direction.js";

/**
 * The actual deterministic transformation: given one Tailwind utility
 * token, decide whether this generator recognizes it as something a
 * design direction controls, and if so, what it becomes under a specific
 * direction. Everything NOT recognized here (layout utilities like
 * `flex`/`items-center`/`gap-4`, arbitrary values like `rounded-[12px]`,
 * anything not shaped like a plain `{prefix}-{family}-{shade}` color
 * utility) is left completely alone — the same "refuse to guess" stance
 * the validator takes about dynamic className expressions, applied here
 * to utility tokens this generator doesn't have a confident, mechanical
 * answer for.
 *
 * v1 scope, deliberately: color re-hueing and radius normalization only.
 * A type scale and a spacing rhythm are part of the same design-direction
 * heuristic (see reference-design-direction.md) but applying them
 * generically needs to know what ROLE an element plays — is this `h1` a
 * page title or a card header, is this `text-sm` a label or truncated
 * body copy — which a tag name or existing class alone doesn't reliably
 * answer. That judgment call is left to the AI-driven skill
 * (`/revamp`), not guessed at here.
 *
 * Also v1 scope, found while testing against the real fixtures rather
 * than planned up front: a variant-prefixed utility (`hover:bg-slate-800`,
 * `focus:ring-2`, `dark:bg-zinc-900`) doesn't match `COLOR_TOKEN_RE` at
 * all — the regex is anchored to the whole token, and a `hover:` prefix
 * isn't one of the recognized color prefixes — so these are left
 * completely untouched. Recognizing them is a reasonable future
 * extension (strip a known pseudo-class prefix, remap what's left, add
 * the prefix back), deliberately not attempted in v1: the real fixture's
 * own `Button` (`hover:bg-slate-800`) is proof this case exists in
 * practice, not a hypothetical.
 */

const COLOR_PREFIXES = ["text", "bg", "border", "ring", "divide", "from", "via", "to", "fill", "stroke"] as const;
const COLOR_FAMILIES = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;

const COLOR_TOKEN_RE = new RegExp(`^(${COLOR_PREFIXES.join("|")})-(${COLOR_FAMILIES.join("|")})-(\\d{2,3})$`);

/** `rounded-full` is intentionally not matched — it marks a pill/avatar
 * shape, a semantic choice about the element's form, not a styling knob
 * this generator's radius normalization should touch. */
const RADIUS_TOKEN_RE = /^rounded(-(none|sm|md|lg|xl|2xl|3xl))?$/;

function classifyFamily(family: string): "neutral" | "danger" | "primary" {
  if ((NEUTRAL_FAMILIES as readonly string[]).includes(family)) return "neutral";
  if ((DANGER_FAMILIES as readonly string[]).includes(family)) return "danger";
  return "primary";
}

/** The replacement for one token under `direction`, or `undefined` if this
 * token is unrecognized or already matches the direction (nothing to
 * change — never emit a same-value "replacement"). */
export function remapToken(token: string, direction: DesignDirection): string | undefined {
  const colorMatch = token.match(COLOR_TOKEN_RE);
  if (colorMatch) {
    const [, prefix, family, shade] = colorMatch as unknown as [string, string, string, string];
    const targetFamily = direction[classifyFamily(family)];
    return targetFamily === family ? undefined : `${prefix}-${targetFamily}-${shade}`;
  }
  if (RADIUS_TOKEN_RE.test(token)) {
    return token === direction.radius ? undefined : direction.radius;
  }
  return undefined;
}

/**
 * The full set of NEW tokens a className needs under `direction` — not
 * the whole recomputed className. `set_class_list`'s own contract (see
 * editOps.ts) is "the applier merges old + new via tailwind-merge," so
 * handing back only what's actually changing lets tailwind-merge do
 * exactly what it's for: the untouched tokens survive from the old value
 * automatically, and a changed color/radius token displaces its
 * same-group predecessor because it comes later in the merged string.
 * Returns `[]` when nothing in `className` needs to change — callers
 * should skip emitting an op entirely in that case, same as every other
 * "don't emit a no-op edit" rule elsewhere in this project.
 */
export function remapClassName(className: string, direction: DesignDirection): string[] {
  const tokens = className.split(/\s+/).filter(Boolean);
  const replacements = new Set<string>();
  for (const token of tokens) {
    const replacement = remapToken(token, direction);
    if (replacement) replacements.add(replacement);
  }
  return [...replacements];
}
