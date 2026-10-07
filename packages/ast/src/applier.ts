import { Node } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { twMerge } from "tailwind-merge";
import { resolveAddress, attributesHolder, getSignificantChildren } from "./addressing.js";
import { findCvaCall, getVariantOptionInitializer } from "./cva.js";
import { validateEditBatch } from "./validator.js";
import { extractLogicSkeleton, hashSource } from "./logicSkeleton.js";
import type {
  EditBatch,
  EditOp,
  SetClassListOp,
  SetCvaVariantsOp,
  WrapElementOp,
  InsertPresentationalOp,
  AddImportOp,
} from "./editOps.js";

/**
 * The applier — the only thing in this package allowed to actually change a
 * file's text. Everything upstream (editOps.ts, validator.ts) exists so
 * that by the time an op reaches here, "is this legal" has already been
 * answered; this module's only remaining job is "do exactly what the op
 * says, then prove the result still honors whichever guarantee that op
 * belongs to" (see editOps.ts's HASH-PRESERVING vs STRUCTURE-EXTENDING
 * split).
 *
 * Contract:
 *  1. Validate the whole batch against the tree as it stands right now.
 *     Nothing mutates if anything is already wrong.
 *  2. Apply every op in array order, re-resolving its address immediately
 *     before touching it — never a cached Node from step 1 or from
 *     enumeration. This is what makes a later op in the same batch see the
 *     effect of an earlier one, which matters even though the validator
 *     caps a batch at one structural op (Phase 1 scope cut — see
 *     docs/phase-1-edit-safety-layer.md): a `set_class_list` after a
 *     `wrap_element` in the same batch still needs the live tree, not the
 *     one the batch was built against.
 *  3. Gate the result: a batch with no structural op must leave the
 *     logic-skeleton hash byte-for-byte identical; a batch with one must
 *     leave every original token in place, in order, with nothing new
 *     except exactly the tokens that specific op is allowed to introduce.
 *  4. On ANY failure — a runtime resolve failure, a gate failure — revert
 *     the SourceFile to its pre-batch text and return every error
 *     collected. All-or-nothing, the same promise editOps.ts documents.
 *
 * The `sourceFile` passed in is consumed: it is mutated in place
 * regardless of whether the batch ultimately succeeds (on failure it's
 * restored to its original text, not left half-edited, but it's still a
 * fresh ts-morph node graph, not the one callers may have cached
 * references into). Treat it as disposable and read the result off the
 * returned `code` string, never off `sourceFile.getFullText()` after the
 * fact.
 */

export interface ApplyError {
  opIndex: number;
  op: EditOp["op"];
  reason: string;
}

export type ApplyResult = { ok: true; code: string } | { ok: false; errors: ApplyError[] };

export function applyEditBatch(sourceFile: SourceFile, filename: string, batch: EditBatch): ApplyResult {
  const validation = validateEditBatch(sourceFile, batch);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const originalText = sourceFile.getFullText();
  const errors: ApplyError[] = [];
  const fail = (opIndex: number, op: EditOp["op"], reason: string) => errors.push({ opIndex, op, reason });

  for (let opIndex = 0; opIndex < batch.ops.length; opIndex++) {
    if (errors.length > 0) break; // stop mutating further; still reverting everything below
    const op = batch.ops[opIndex]!;
    switch (op.op) {
      case "set_class_list":
        applySetClassList(sourceFile, op, opIndex, fail);
        break;
      case "set_cva_variants":
        applySetCvaVariants(sourceFile, op, opIndex, fail);
        break;
      case "wrap_element":
        applyWrapElement(sourceFile, op, opIndex, fail);
        break;
      case "insert_presentational":
        applyInsertPresentational(sourceFile, op, opIndex, fail);
        break;
      case "add_import":
        applyAddImport(sourceFile, op, opIndex, fail);
        break;
    }
  }

  if (errors.length > 0) {
    sourceFile.replaceWithText(originalText);
    return { ok: false, errors };
  }

  const finalText = sourceFile.getFullText();
  const structuralOp = batch.ops.find((op): op is WrapElementOp | InsertPresentationalOp =>
    op.op === "wrap_element" || op.op === "insert_presentational"
  );
  const importOps = batch.ops.filter((op): op is AddImportOp => op.op === "add_import");

  // add_import is neither hash-preserving nor structure-extending (see
  // editOps.ts) — it adds a real `import:...` token (logicSkeleton.ts
  // tokenizes every ImportDeclaration), so a batch that includes one can't
  // be held to byte-for-byte hash equality. It CAN be held to the same
  // narrower "only these specific tokens are new" discipline as a
  // structural op, just with a different, independently-computed
  // allowlist — so any batch containing an add_import or a structural op
  // (or both) goes through the one general gate; a batch with neither
  // keeps the simpler, stronger hash-equality check.
  const gate =
    structuralOp || importOps.length > 0
      ? checkTokenDiff(originalText, finalText, filename, structuralOp, importOps)
      : checkHashPreserved(originalText, finalText, filename);

  if (!gate.ok) {
    sourceFile.replaceWithText(originalText);
    const opIndex = structuralOp ? batch.ops.indexOf(structuralOp) : 0;
    const op = structuralOp ?? batch.ops[0]!;
    return { ok: false, errors: [{ opIndex, op: op.op, reason: gate.reason }] };
  }

  return { ok: true, code: finalText };
}

// ---------------------------------------------------------------------------
// Per-op mutations. Each re-resolves its own address against the live tree
// (see the module docstring, point 2) and reports through `fail` rather than
// throwing — one op's runtime failure shouldn't stop the others from being
// attempted, since applyEditBatch collects everything before reverting.
// ---------------------------------------------------------------------------

type Fail = (opIndex: number, op: EditOp["op"], reason: string) => void;

/** Every place this module sets a Tailwind class string goes through here:
 * one function that decides what "the new value" is, so there is exactly
 * one answer in the whole engine to "what happens to conflicting
 * utilities." Composing old+new and letting tailwind-merge resolve
 * conflicts (source-order wins) is what lets every op's `className`/value
 * field be a plain, naively-composable string rather than a diff the
 * caller has to pre-resolve — see editOps.ts's SetClassListOpSchema.
 */
function mergeClasses(oldValue: string, newValue: string): string {
  return twMerge(`${oldValue} ${newValue}`.trim());
}

function applySetClassList(sourceFile: SourceFile, op: SetClassListOp, opIndex: number, fail: Fail): void {
  const resolved = resolveAddress(sourceFile, op.address);
  if (!resolved.ok) {
    fail(opIndex, op.op, `address no longer resolves (an earlier op in this batch may have changed the tree): ${resolved.reason}`);
    return;
  }
  const node = resolved.node;
  if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) {
    fail(opIndex, op.op, `resolved node cannot carry a className — it's a ${node.getKindName()}`);
    return;
  }
  const holder = attributesHolder(node);
  const existing = holder.getAttribute("className");

  let oldValue = "";
  if (existing) {
    if (!Node.isJsxAttribute(existing)) {
      fail(opIndex, op.op, "existing className comes from a spread attribute — cannot see into it to merge");
      return;
    }
    const init = existing.getInitializer();
    if (init && !Node.isStringLiteral(init)) {
      fail(opIndex, op.op, "existing className is not a plain string literal — cannot merge into it");
      return;
    }
    oldValue = init && Node.isStringLiteral(init) ? init.getLiteralValue() : "";
  }

  const merged = mergeClasses(oldValue, op.className);
  if (existing && Node.isJsxAttribute(existing)) {
    existing.setInitializer(JSON.stringify(merged));
  } else {
    holder.addAttribute({ name: "className", initializer: JSON.stringify(merged) });
  }
}

function applySetCvaVariants(sourceFile: SourceFile, op: SetCvaVariantsOp, opIndex: number, fail: Fail): void {
  const info = findCvaCall(sourceFile, op.varName);
  if (!info) {
    fail(opIndex, op.op, `no cva(...) call assigned to "${op.varName}" found (an earlier op in this batch may have changed the tree)`);
    return;
  }

  if (op.base !== undefined) {
    if (!info.baseArg || !Node.isStringLiteral(info.baseArg)) {
      fail(opIndex, op.op, `"${op.varName}"'s base argument is not a rewritable string literal`);
      return;
    }
    info.baseArg.setLiteralValue(mergeClasses(info.baseArg.getLiteralValue(), op.base));
  }

  if (op.variants) {
    for (const [group, options] of Object.entries(op.variants)) {
      for (const [optionName, value] of Object.entries(options)) {
        const node = getVariantOptionInitializer(info, group, optionName);
        if (!node || !Node.isStringLiteral(node)) {
          fail(opIndex, op.op, `"${op.varName}" variant "${group}.${optionName}" is not a rewritable string literal`);
          return;
        }
        node.setLiteralValue(mergeClasses(node.getLiteralValue(), value));
      }
    }
  }
}

/** The wrapped node is moved verbatim (`node.getText()`, unmodified) inside
 * the new wrapper — this is what makes "wrapping can't change behavior"
 * true by construction, matching WrapElementOpSchema's own guarantee. */
function applyWrapElement(sourceFile: SourceFile, op: WrapElementOp, opIndex: number, fail: Fail): void {
  const resolved = resolveAddress(sourceFile, op.address);
  if (!resolved.ok) {
    fail(opIndex, op.op, `address no longer resolves: ${resolved.reason}`);
    return;
  }
  const classAttr = op.wrapperClassName !== undefined ? ` className=${JSON.stringify(twMerge(op.wrapperClassName))}` : "";
  const original = resolved.node.getText();
  resolved.node.replaceWithText(`<${op.wrapperTag}${classAttr}>${original}</${op.wrapperTag}>`);
}

/** Always a self-closing leaf (the schema has no children field for this
 * op — see InsertPresentationalOpSchema), inserted at a raw text position
 * computed from the parent's current significant children rather than
 * through a JSX-child-list API ts-morph doesn't expose generically for
 * JsxElement/JsxFragment. */
function applyInsertPresentational(sourceFile: SourceFile, op: InsertPresentationalOp, opIndex: number, fail: Fail): void {
  const resolved = resolveAddress(sourceFile, op.parentAddress);
  if (!resolved.ok) {
    fail(opIndex, op.op, `parentAddress no longer resolves (an earlier op in this batch may have changed the tree): ${resolved.reason}`);
    return;
  }
  const parent = resolved.node;
  if (!Node.isJsxElement(parent) && !Node.isJsxFragment(parent)) {
    fail(opIndex, op.op, `parentAddress no longer resolves to an element/fragment with a body — it's a ${parent.getKindName()}`);
    return;
  }

  const siblings = getSignificantChildren(parent);
  if (op.atIndex > siblings.length) {
    fail(opIndex, op.op, `atIndex ${op.atIndex} is out of range — parent now has ${siblings.length} significant children`);
    return;
  }

  let attrsText = "";
  if (op.className !== undefined) attrsText += ` className=${JSON.stringify(twMerge(op.className))}`;
  for (const [name, value] of Object.entries(op.attributes ?? {})) attrsText += ` ${name}=${JSON.stringify(value)}`;
  const insertion = ` <${op.tag}${attrsText} /> `;

  const insertPos =
    op.atIndex < siblings.length
      ? siblings[op.atIndex]!.getStart()
      : siblings.length > 0
        ? siblings[siblings.length - 1]!.getEnd()
        : Node.isJsxFragment(parent)
          ? parent.getOpeningFragment().getEnd()
          : parent.getOpeningElement().getEnd();

  sourceFile.insertText(insertPos, insertion);
}

function applyAddImport(sourceFile: SourceFile, op: AddImportOp, opIndex: number, fail: Fail): void {
  if (op.imported === "default") {
    sourceFile.addImportDeclaration({ moduleSpecifier: op.source, defaultImport: op.localName });
    return;
  }
  sourceFile.addImportDeclaration({
    moduleSpecifier: op.source,
    namedImports: [op.imported === op.localName ? op.imported : { name: op.imported, alias: op.localName }],
  });
}

// ---------------------------------------------------------------------------
// The two gates. See editOps.ts's module docstring for why there are two
// different guarantees here rather than one.
// ---------------------------------------------------------------------------

type GateResult = { ok: true } | { ok: false; reason: string };

function checkHashPreserved(before: string, after: string, filename: string): GateResult {
  const hashBefore = hashSource(before, filename);
  const hashAfter = hashSource(after, filename);
  if (hashBefore === hashAfter) return { ok: true };
  return {
    ok: false,
    reason:
      "internal error: this batch contains no structure-extending op, so the logic-skeleton hash must not move, " +
      "but it did — reverted rather than landing a change that broke the no-logic-change guarantee",
  };
}

/** The tag/attribute tokens a structural op is allowed to introduce (see
 * editOps.ts's STRUCTURE-EXTENDING commentary). Order doesn't matter —
 * `checkTokenDiff` compares this as a multiset — only that nothing else
 * snuck in. */
function structuralOpTokens(op: WrapElementOp | InsertPresentationalOp): string[] {
  if (op.op === "wrap_element") return [`jsx-open:${op.wrapperTag}`];
  const tokens = [`jsx-open:${op.tag}`];
  for (const [name, value] of Object.entries(op.attributes ?? {})) {
    tokens.push(`jsx-attr:${name}`, `str:${value}`);
  }
  return tokens;
}

/** The exact `import:<source>:<specs>` token logicSkeleton.ts's
 * ImportDeclaration visitor will produce for this op, computed the same
 * way it is there — this op always introduces its own standalone import
 * declaration with exactly one specifier (see applyAddImport's own
 * "known v1 simplification" note), so there is exactly one such token to
 * expect per add_import op. */
function addImportToken(op: AddImportOp): string {
  const spec = op.imported === "default" ? `default:${op.localName}` : op.imported === op.localName ? op.imported : `${op.imported} as ${op.localName}`;
  return `import:${op.source}:${spec}`;
}

/**
 * Verifies: every token present before is still present after, in the same
 * relative order (a plain greedy left-to-right subsequence match — correct
 * here because the only source of "after" text is this module's own
 * controlled mutation, not an arbitrary diff to reconcile), and whatever
 * got inserted is exactly the allowlisted set for the structural op and/or
 * add_import ops this batch actually contains, no more, no less.
 * className/wrapperClassName never appear here at all, on either side —
 * they're excluded from the hash before this check ever runs.
 */
function checkTokenDiff(
  before: string,
  after: string,
  filename: string,
  structuralOp: WrapElementOp | InsertPresentationalOp | undefined,
  importOps: AddImportOp[]
): GateResult {
  const tokensBefore = extractLogicSkeleton(before, filename).tokens;
  const tokensAfter = extractLogicSkeleton(after, filename).tokens;

  let bi = 0;
  const inserted: string[] = [];
  for (const tok of tokensAfter) {
    if (bi < tokensBefore.length && tokensBefore[bi] === tok) {
      bi++;
    } else {
      inserted.push(tok);
    }
  }
  if (bi !== tokensBefore.length) {
    return {
      ok: false,
      reason: "a token present before this op is missing or reordered after it — something existing changed, not just something new added",
    };
  }

  const expected = [...(structuralOp ? structuralOpTokens(structuralOp) : []), ...importOps.map(addImportToken)].sort();
  const actual = inserted.sort();
  if (actual.length !== expected.length || actual.some((t, i) => t !== expected[i])) {
    return {
      ok: false,
      reason: `unexpected token change — inserted [${actual.join(", ")}], expected exactly [${expected.join(", ")}]`,
    };
  }
  return { ok: true };
}
