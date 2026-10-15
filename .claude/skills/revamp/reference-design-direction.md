# Choosing a design direction

A heuristic, not a formula — the point is to make the decision systematically
and be able to justify each choice, not to arrive at one specific palette.

## The tooling boundary this has to work within

**None of the five edit ops can touch the Tailwind theme file** (the
`@theme { --color-...: ...; }` block `scan_project`'s stack info points you
at). Every op operates on a component's JSX/TSX source via `ts-morph` —
there is no op for editing arbitrary CSS. This means a design direction has
to be expressible entirely through:

- Tailwind's **built-in palette** (`slate`, `zinc`, `blue`, `emerald`,
  `amber`, `rose`, etc., each with numeric shades `50`–`950`) and built-in
  scales (`text-sm`/`text-base`/`text-lg`/..., `p-2`/`p-4`/`p-6`/...,
  `rounded-md`/`rounded-lg`/...), or
- Tailwind's arbitrary-value syntax (`bg-[#0f766e]`, `text-[15px]`) where a
  built-in shade genuinely isn't close enough, or
- an **existing** `@theme` token already defined in the project's own
  `app.css` (referenced by name, e.g. `bg-primary`, never introduced fresh).

If a direction seems to need a brand-new CSS custom property, that's a sign
it needs work outside this skill's scope (hand-editing the theme file,
which this skill explicitly never does) — scale the ambition back to what's
expressible in utilities instead, rather than reaching for a tool this
project doesn't have.

## 1. Pick one anchor hue, tied to the product, not arbitrary

Look at the product brief `scan_project` returned. A logistics/ops tool
reads differently than a consumer app — an anchor hue is a decision, not a
default. A few starting points, not a rule:

- Operational / dense data tools (dashboards, admin panels): a desaturated,
  cool anchor (`slate`, `zinc`, `blue`) reads as calm and doesn't fight with
  dense content.
- Consumer-facing, lower density: a warmer or more saturated anchor
  (`indigo`, `emerald`, `rose`) can carry more personality since there's
  less competing content per screen.
- Anything with a destructive/danger state (delete, alert, low-stock) needs
  its own, separate hue (`red`/`rose`) — never reuse the anchor hue for both
  "primary action" and "danger," even at different shades; that's exactly
  the kind of ambiguity "coherent" is supposed to rule out.

Pick ONE anchor family for primary actions/emphasis, ONE neutral family for
backgrounds/borders/body text (almost always `slate`/`zinc`/`neutral` —
resist the urge to make neutrals interesting), and ONE danger family if the
product needs one. Three families, not five.

## 2. Check contrast, don't eyeball it

WCAG AA: body text needs ≥4.5:1 contrast against its background; large text
(≥24px, or ≥19px bold) and UI component boundaries need ≥3:1. Tailwind's own
shade numbers are a reasonable proxy without computing exact ratios by hand:

- Body text on a white/near-white background: shade `700` or darker from the
  neutral family (`slate-700`+), never lighter than `600`.
- Body text on a saturated/dark background: shade `50`–`100` from whichever
  family the background uses.
- A colored badge/button background below `500` (i.e. `100`–`400`) needs
  dark text on it (`800`–`900` of the same or neutral family), not white —
  light-on-light-ish is the single most common accessibility miss in a
  "quick restyle."

If genuinely unsure, pick a pairing from the project's own existing fixture
(e.g. `fleet-dashboard`'s `text-emerald-800` on `bg-emerald-100`,
`text-red-800` on `bg-red-100`) — those are human-reviewed-shaped
pairings already in this repo, not a bad place to anchor a new one.

## 3. Type scale: pick a ratio, use it everywhere

Don't assign font sizes per element by feel. Decide a small, ordered scale
up front — e.g. `text-sm` (meta/labels) → `text-base` (body) →
`text-lg`/`text-xl` (section headers) → `text-2xl`/`text-3xl` (page title) —
and use exactly those steps everywhere in the file(s) you touch. Two font
weights total (`font-normal`/`font-medium` for most things, `font-semibold`
or `font-bold` for emphasis/headings) is plenty; a third weight rarely earns
its place and reads as inconsistency, not richness.

## 4. Spacing rhythm: one scale, not arbitrary values

Pick a small set of spacing steps (e.g. `2`, `4`, `6`, `8`, `12` in
Tailwind's 4px-based scale) and compose every margin/padding/gap from that
set. A `className` that mixes `p-5` next to `p-4` next to `p-[18px]` in the
same file is exactly the kind of incoherence a reviewer notices immediately
even if they can't articulate why.

## 5. Mapping onto `cva()` variants

When `scan_project`'s component list shows a `cva()`-based primitive (e.g.
a `Badge`/`Button` with `variants: { intent: {...} }` or `{ status: {...} }`
groups), the group *names* and *option names* are logic — `set_cva_variants`
can't introduce or rename one, only rewrite what class string an existing
option resolves to. Use this to your advantage: map your chosen palette
onto the EXISTING semantic options (`active`/`idle`/`alert`,
`primary`/`secondary`, `default`/`outline`/`ghost`, whatever the file
already declares) rather than treating variant naming as something you get
to redesign — that naming is the product's own vocabulary, not a styling
detail.
