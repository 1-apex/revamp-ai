import { z } from "zod";

/**
 * The edit-op schema — the only vocabulary a host agent (or anything else)
 * is allowed to use to change a file. There is no "write arbitrary text"
 * escape hatch anywhere in this module; if an operation isn't one of the
 * five shapes below, it doesn't exist as far as the applier is concerned.
 *
 * Two different kinds of guarantee are encoded here, and it matters which
 * an op belongs to:
 *
 *  - HASH-PRESERVING ops (`set_class_list`, `set_cva_variants`) touch only
 *    things the logic-skeleton hash already ignores. The applier's gate for
 *    these is simple: hash before === hash after, full stop.
 *
 *  - STRUCTURE-EXTENDING ops (`wrap_element`, `insert_presentational`)
 *    deliberately add a new, purely decorative JSX node, so the raw
 *    skeleton hash WILL move (see the Phase 0 known limitation in the
 *    README). Their guarantee is narrower and different: every token that
 *    existed before must still be present, in the same order, and the
 *    only new tokens must be exactly the ones this specific op is allowed
 *    to introduce (a wrapper tag name, or a decorative leaf tag name plus
 *    an attribute drawn from an explicit allowlist) — never a handler,
 *    never a hook, never anything that isn't already excluded from the
 *    hash for being presentational. Enforcing that diff is the applier's
 *    job (Phase 1, next); this module only makes sure a structurally
 *    invalid op can't be constructed or parsed in the first place.
 *
 *  - `add_import` is neither: it doesn't touch any component's body at
 *    all, only the top of the file. Its safety comes entirely from the
 *    source allowlist below plus a collision check the validator does
 *    against the real file (can't shadow an existing local name) — not
 *    from anything the hash can see.
 *
 * As much of "is this even a legal op" as possible is enforced right here,
 * with zod, at the boundary where untrusted JSON turns into a typed value.
 * What's deliberately left to the validator (Phase 1, task #18) is only
 * the checks that need the actual file content to answer: does this
 * address still resolve, do these cva variant names already exist, is
 * this import name already taken.
 */

// ---------------------------------------------------------------------------
// Shared: the address a JSX-targeting op resolves against (see addressing.ts)
// ---------------------------------------------------------------------------

export const EditAddressSchema = z.object({
  file: z.string().min(1),
  component: z.string().min(1),
  root: z.number().int().nonnegative(),
  path: z.array(z.number().int().nonnegative()),
});
export type EditAddressInput = z.infer<typeof EditAddressSchema>;

// ---------------------------------------------------------------------------
// Allowlists. These are deliberately conservative starting points, not the
// final word — a direction pack should be able to extend them — but v1
// ships with a fixed, hardcoded set so "what's allowed" is auditable in one
// place rather than configured away by accident.
// ---------------------------------------------------------------------------

/** Tags `wrap_element` may introduce. All are semantics-free containers —
 * nothing here can carry an implicit role, a form action, or a navigation
 * target, which is the whole point: a wrapper cannot change behavior. */
export const WRAPPER_TAG_ALLOWLIST = ["div", "span", "section", "figure"] as const;
export type WrapperTag = (typeof WRAPPER_TAG_ALLOWLIST)[number];

/** Tags `insert_presentational` may introduce. Same reasoning — purely
 * decorative or structural, never interactive or content-bearing on their
 * own. Icon components are referenced by their imported local name, which
 * must itself have arrived via a validated `add_import` op; the tag name
 * here is checked against this fixed list OR against the set of local
 * names introduced by add_import ops in the same batch (the validator's
 * job, since only it can see the batch as a whole). */
export const PRESENTATIONAL_INSERT_TAG_ALLOWLIST = ["div", "span", "hr", "br"] as const;
export type PresentationalInsertTag = (typeof PRESENTATIONAL_INSERT_TAG_ALLOWLIST)[number];

/** Attribute names `insert_presentational` may set, beyond className/style.
 * Every one of these is inert with respect to behavior: it changes how
 * something looks or how assistive tech announces it, never what happens
 * when it's interacted with. Notably absent: anything starting with `on`,
 * `href`, `src`, `action`, `formAction`, `to` (router links), `ref`. */
const PRESENTATIONAL_ATTRIBUTE_ALLOWLIST = [
  "aria-hidden",
  "aria-label",
  "role",
  "width",
  "height",
  "viewBox",
  "fill",
  "stroke",
  "strokeWidth",
  "focusable",
] as const;

const presentationalAttributeName = z.string().refine(
  (name) => (PRESENTATIONAL_ATTRIBUTE_ALLOWLIST as readonly string[]).includes(name),
  (name) => ({
    message: `attribute "${name}" is not on the presentational allowlist — if this needs to carry behavior, it cannot go through insert_presentational at all`,
  })
);

/** A className/style-only guard used by every op that's allowed to touch
 * an attribute map: reject anything that looks like an event handler even
 * if it somehow got past the explicit allowlist above (defense in depth,
 * not the primary gate). */
const NOT_A_HANDLER_NAME = /^on[A-Z]/;

// ---------------------------------------------------------------------------
// 1. set_class_list — replace the className on an addressed JSX node.
// ---------------------------------------------------------------------------

export const SetClassListOpSchema = z.object({
  op: z.literal("set_class_list"),
  address: EditAddressSchema,
  /** The full replacement value, not a diff. tailwind-merge normalizes
   * conflicting utilities at apply time (source-order wins), so this can
   * be composed naively (old classes + new classes concatenated) without
   * the caller having to resolve conflicts itself. */
  className: z.string(),
});
export type SetClassListOp = z.infer<typeof SetClassListOpSchema>;

// ---------------------------------------------------------------------------
// 2. set_cva_variants — edit the class-string VALUES inside a cva() call,
//    never its variant group/option KEY names (those are structure, and
//    the logic-skeleton hash already treats them that way — see
//    cvaVariantKeys() in logicSkeleton.ts).
// ---------------------------------------------------------------------------

/** group name -> option name -> new class string for that option. Every
 * group and option named here must already exist in the target cva() call
 * — the validator checks that against the real file; this schema just
 * shapes the payload. */
const CvaVariantValuesSchema = z.record(z.string(), z.record(z.string(), z.string()));

export const SetCvaVariantsOpSchema = z.object({
  op: z.literal("set_cva_variants"),
  file: z.string().min(1),
  /** the local variable name the cva(...) call is assigned to, e.g. the
   * `buttonVariants` in `const buttonVariants = cva(...)` */
  varName: z.string().min(1),
  /** optional new value for cva's base class string (the first argument,
   * or the "base" you'd merge in regardless of variant selection) */
  base: z.string().optional(),
  variants: CvaVariantValuesSchema.optional(),
});
export type SetCvaVariantsOp = z.infer<typeof SetCvaVariantsOpSchema>;

// ---------------------------------------------------------------------------
// 3. wrap_element — introduce a purely decorative wrapper around an
//    addressed node. The wrapped node itself is moved, verbatim, inside
//    the new wrapper — this schema has no field through which its props,
//    children, or text could be altered, which is what makes "wrapping
//    can't change behavior" true by construction rather than by promise.
// ---------------------------------------------------------------------------

export const WrapElementOpSchema = z.object({
  op: z.literal("wrap_element"),
  /** the node to wrap; becomes the wrapper's sole child, unchanged */
  address: EditAddressSchema,
  wrapperTag: z.enum(WRAPPER_TAG_ALLOWLIST),
  wrapperClassName: z.string().optional(),
});
export type WrapElementOp = z.infer<typeof WrapElementOpSchema>;

// ---------------------------------------------------------------------------
// 4. insert_presentational — add a new decorative leaf node among an
//    addressed parent's children. Always self-closing in effect: this
//    schema has no children field, so an inserted node can never carry
//    content, let alone logic.
// ---------------------------------------------------------------------------

export const InsertPresentationalOpSchema = z.object({
  op: z.literal("insert_presentational"),
  /** the parent to insert into */
  parentAddress: EditAddressSchema,
  /** position among the parent's CURRENT significant children, 0 = first.
   * Re-checked against the live child count at apply time, same as every
   * other index in this system — never trusted blindly. */
  atIndex: z.number().int().nonnegative(),
  /** either a fixed presentational tag, or the local name of a component
   * introduced by an add_import op earlier in the same batch (the
   * validator resolves which case this is; the schema just requires a
   * non-empty identifier-shaped string) */
  tag: z.string().min(1),
  className: z.string().optional(),
  attributes: z.record(presentationalAttributeName, z.string()).optional(),
});
export type InsertPresentationalOp = z.infer<typeof InsertPresentationalOpSchema>;

// ---------------------------------------------------------------------------
// 5. add_import — add a named or default import to the top of a file.
//    Exists only to support wrap_element / insert_presentational pulling
//    in a decorative component (an icon, typically); never a way to bring
//    in arbitrary code.
// ---------------------------------------------------------------------------

/** Module specifiers allowed as an import source. Prefix entries (ending
 * in `/`) match anything under that path — e.g. local design-system
 * components. Everything else must match exactly. Deliberately small: growing
 * this list is a reviewable, one-line decision, not something an op payload
 * can expand on its own. */
export const IMPORT_SOURCE_ALLOWLIST = [
  "lucide-react",
  "@radix-ui/react-icons",
  "clsx",
  "class-variance-authority",
  "@/components/ui/",
  "@/lib/",
] as const;

export const AddImportOpSchema = z.object({
  op: z.literal("add_import"),
  file: z.string().min(1),
  source: z.string().min(1).refine(
    (source) =>
      (IMPORT_SOURCE_ALLOWLIST as readonly string[]).some((allowed) =>
        allowed.endsWith("/") ? source.startsWith(allowed) : source === allowed
      ),
    (source) => ({ message: `import source "${source}" is not on the allowlist` })
  ),
  /** the exported name to import, or "default" for a default export */
  imported: z.string().min(1),
  /** the local binding name this import is introduced under */
  localName: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "localName must be a valid JS identifier"),
});
export type AddImportOp = z.infer<typeof AddImportOpSchema>;

// ---------------------------------------------------------------------------
// The union, and a batch of them scoped to one file.
// ---------------------------------------------------------------------------

const EditOpUnionSchema = z.discriminatedUnion("op", [
  SetClassListOpSchema,
  SetCvaVariantsOpSchema,
  WrapElementOpSchema,
  InsertPresentationalOpSchema,
  AddImportOpSchema,
]);

/**
 * Cross-field checks that `discriminatedUnion` can't express on its own —
 * it needs each member to be a plain ZodObject to read the discriminant,
 * so refinements that depend on more than one field of a single op live
 * here instead, applied once to the union as a whole.
 */
export const EditOpSchema = EditOpUnionSchema.superRefine((op, ctx) => {
  if (op.op === "set_cva_variants") {
    const hasVariants = op.variants && Object.keys(op.variants).length > 0;
    if (op.base === undefined && !hasVariants) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "set_cva_variants must change at least one of base or variants — an empty op is not allowed",
      });
    }
  }
  if (op.op === "insert_presentational") {
    const handlerLike = Object.keys(op.attributes ?? {}).filter((k) => NOT_A_HANDLER_NAME.test(k));
    if (handlerLike.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `insert_presentational attributes cannot include an event handler: ${handlerLike.join(", ")}`,
        path: ["attributes"],
      });
    }
  }
});
export type EditOp = z.infer<typeof EditOpUnionSchema>;

/**
 * A batch is applied to ONE file, all-or-nothing: if any op in the batch
 * fails validation or the final hash check, none of them land. That's
 * enforced by the applier (Phase 1, task #19), not by this schema — but
 * the type shape reflects it, since every op in a batch implicitly shares
 * the batch's `file`.
 */
export const EditBatchSchema = z.object({
  file: z.string().min(1),
  ops: z.array(EditOpSchema).min(1),
});
export type EditBatch = z.infer<typeof EditBatchSchema>;

/** Parse untrusted JSON into a validated EditBatch, or throw a ZodError
 * with a precise path to whatever was malformed. This is the one function
 * anything outside this package should call — never construct an EditOp
 * by hand-casting a plain object with `as`. */
export function parseEditBatch(json: unknown): EditBatch {
  return EditBatchSchema.parse(json);
}
