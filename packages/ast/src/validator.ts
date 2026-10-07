import { Node, type SourceFile, type JsxElement, type JsxSelfClosingElement } from "ts-morph";
import { resolveAddress, countSignificantChildren, addressKey, attributesHolder } from "./addressing.js";
import { findCvaCall, cvaVariantKeys, getVariantOptionInitializer } from "./cva.js";
import { PRESENTATIONAL_INSERT_TAG_ALLOWLIST, type EditOp, type EditBatch, type EditAddressInput } from "./editOps.js";

/**
 * The validator — everything about "is this batch legal" that needs the
 * actual file content to answer, which is exactly what the schema (Phase
 * 1, task #17) couldn't check on its own. `editOps.ts` already rejects a
 * structurally invalid op; this module rejects a structurally valid op
 * that doesn't match reality: an address that no longer resolves, a cva
 * variant name that was never there, an import name already taken, a
 * className that isn't a plain string the applier can safely rewrite.
 *
 * Every op in the batch is checked, even after an earlier one fails —
 * this collects everything wrong at once rather than stopping at the
 * first error, because the applier's contract (task #19) is all-or-
 * nothing: one illegal op reverts the whole batch, so the caller should
 * see every reason, not just the first.
 */

export interface OpError {
  opIndex: number;
  op: EditOp["op"];
  reason: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: OpError[];
}

function isJsxCapable(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

/** A JsxFragment (`<>...</>`) renders no DOM node of its own, so it has
 * nowhere to put a className — only a real element does. */
function canHaveClassName(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node);
}

/**
 * A className value the applier can safely merge into: either there isn't
 * one yet (nothing to check), or it's a plain string literal. Anything
 * dynamic — `className={cn(...)}`, a template literal, a ternary — is left
 * alone rather than guessed at; this is the same "refuse to guess" stance
 * `resolveAddress` takes about structure, applied here to values. The real
 * fixture's own `Badge` component (`className={cn(badgeVariants({status}),
 * className)}`) is exactly this case.
 */
function classNameIsRewritable(node: Node): boolean {
  if (!canHaveClassName(node)) return false;
  const holder = attributesHolder(node as JsxElement | JsxSelfClosingElement);
  const attr = holder.getAttribute("className");
  if (!attr) return true; // nothing there yet — the applier will add one
  if (!Node.isJsxAttribute(attr)) return false; // e.g. a spread — can't see into it
  const init = attr.getInitializer();
  return init !== undefined && Node.isStringLiteral(init);
}

function existingImportLocalNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const imp of sourceFile.getImportDeclarations()) {
    const def = imp.getDefaultImport();
    if (def) names.add(def.getText());
    const ns = imp.getNamespaceImport();
    if (ns) names.add(ns.getText());
    for (const named of imp.getNamedImports()) {
      names.add((named.getAliasNode() ?? named.getNameNode()).getText());
    }
  }
  return names;
}

function existingTopLevelNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of sourceFile.getVariableDeclarations()) names.add(decl.getName());
  for (const fn of sourceFile.getFunctions()) {
    const n = fn.getName();
    if (n) names.add(n);
  }
  for (const cls of sourceFile.getClasses()) {
    const n = cls.getName();
    if (n) names.add(n);
  }
  return names;
}

const STRUCTURAL_OPS = new Set<EditOp["op"]>(["wrap_element", "insert_presentational"]);

function sameComponentAndRoot(a: EditAddressInput, b: EditAddressInput): boolean {
  return a.file === b.file && a.component === b.component && a.root === b.root;
}

/** True if `candidate` is the exact node `target` addresses, or anything
 * nested inside it — the set of addresses `wrap_element` invalidates,
 * since wrapping both replaces what's *at* that path and pushes everything
 * below it one level deeper. */
function isSamePathOrDescendant(candidate: number[], target: number[]): boolean {
  if (candidate.length < target.length) return false;
  for (let i = 0; i < target.length; i++) if (candidate[i] !== target[i]) return false;
  return true;
}

/** True if `candidate` addresses a child of `parent` (or something nested
 * inside one) at or after `atIndex` — the set `insert_presentational`
 * shifts by inserting a new sibling. The parent's own path is deliberately
 * NOT included: inserting a child doesn't change what the parent itself
 * resolves to, only its children's indices from the insertion point on. */
function isDescendantAtOrAfterIndex(candidate: number[], parent: number[], atIndex: number): boolean {
  if (candidate.length <= parent.length) return false;
  for (let i = 0; i < parent.length; i++) if (candidate[i] !== parent[i]) return false;
  return candidate[parent.length]! >= atIndex;
}

/** The JSX address an op reads or writes through, if it has one —
 * set_cva_variants and add_import don't address a JSX node at all. */
function jsxAddressOf(op: EditOp): EditAddressInput | undefined {
  if (op.op === "set_class_list" || op.op === "wrap_element") return op.address;
  if (op.op === "insert_presentational") return op.parentAddress;
  return undefined;
}

export function validateEditBatch(sourceFile: SourceFile, batch: EditBatch): ValidationResult {
  const errors: OpError[] = [];

  const existingImports = existingImportLocalNames(sourceFile);
  const existingTopLevel = existingTopLevelNames(sourceFile);

  // Same-batch add_import bookkeeping: which local names does this batch
  // itself introduce (for insert_presentational's tag resolution), and do
  // two add_import ops in the same batch collide with each other (a check
  // the per-file existing-names sets above can't catch on their own).
  const importedLocalNamesInBatch = new Set<string>();
  const seenSoFarInBatch = new Set<string>();
  batch.ops.forEach((op, opIndex) => {
    if (op.op !== "add_import") return;
    if (seenSoFarInBatch.has(op.localName)) {
      errors.push({
        opIndex,
        op: op.op,
        reason: `localName "${op.localName}" is introduced by more than one add_import op in this same batch`,
      });
    }
    seenSoFarInBatch.add(op.localName);
    importedLocalNamesInBatch.add(op.localName);
  });

  // At most one structure-extending op per batch (Phase 1, v1 scope cut —
  // see docs/phase-1-edit-safety-layer.md "why only one structural op").
  // wrap_element never changes a sibling's index (it swaps a node for a
  // wrapper around that same node, in the same slot), but
  // insert_presentational does — it shifts every later sibling's index by
  // one. The applier re-resolves every address fresh, against whatever the
  // tree looks like at that point in the batch, which is exactly what
  // makes a second op's address silently land on the wrong node if an
  // earlier op in the same batch already shifted it: re-resolving finds
  // *a* node at that path, just not the one the caller meant. Capping a
  // batch at one structural op sidesteps that whole class of bug instead
  // of trying to detect it after the fact.
  const structuralOpIndexes = batch.ops.flatMap((op, i) => (STRUCTURAL_OPS.has(op.op) ? [i] : []));
  if (structuralOpIndexes.length > 1) {
    for (const i of structuralOpIndexes) {
      errors.push({
        opIndex: i,
        op: batch.ops[i]!.op,
        reason:
          "a batch may contain at most one structure-extending op (wrap_element / insert_presentational) — " +
          "an earlier structural op in the same batch can shift the sibling indices a later op's address " +
          "depends on. Split these into separate batches.",
      });
    }
  } else if (structuralOpIndexes.length === 1) {
    // Even one structural op can invalidate another op's address *within
    // the same batch* without the sibling-count argument above applying —
    // see isSamePathOrDescendant / isDescendantAtOrAfterIndex. Both ops
    // might individually be fine against the ORIGINAL tree (which is all
    // resolveAddress above checked); this catches the case where the
    // second one's target only exists, at the path it names, because the
    // first one hasn't run yet.
    const sIdx = structuralOpIndexes[0]!;
    const sOp = batch.ops[sIdx]!;
    const ownAddress = jsxAddressOf(sOp)!;
    batch.ops.forEach((op, i) => {
      if (i === sIdx) return;
      const candidate = jsxAddressOf(op);
      if (!candidate || !sameComponentAndRoot(candidate, ownAddress)) return;
      const affected =
        sOp.op === "insert_presentational"
          ? isDescendantAtOrAfterIndex(candidate.path, ownAddress.path, sOp.atIndex)
          : isSamePathOrDescendant(candidate.path, ownAddress.path);
      if (affected) {
        errors.push({
          opIndex: i,
          op: op.op,
          reason:
            `this op's address falls inside the subtree the structural op at index ${sIdx} (${sOp.op}) restructures ` +
            `in this same batch — its position isn't stable until that op has actually landed. Split these into separate batches.`,
        });
      }
    });
  }

  batch.ops.forEach((op, opIndex) => {
    const fail = (reason: string) => errors.push({ opIndex, op: op.op, reason });

    switch (op.op) {
      case "set_class_list": {
        if (op.address.file !== batch.file) {
          fail(`address.file "${op.address.file}" does not match batch file "${batch.file}"`);
          break;
        }
        const resolved = resolveAddress(sourceFile, op.address);
        if (!resolved.ok) {
          fail(`address does not resolve: ${resolved.reason}`);
          break;
        }
        if (!canHaveClassName(resolved.node)) {
          fail(
            `resolved node at ${addressKey(op.address)} cannot carry a className — it's a ${resolved.node.getKindName()}`
          );
          break;
        }
        if (!classNameIsRewritable(resolved.node)) {
          fail(
            `existing className at ${addressKey(op.address)} is not a plain string literal — v1 can only merge ` +
              `into a literal string, never guess at a dynamic expression (e.g. cn(...), a template literal)`
          );
        }
        break;
      }

      case "set_cva_variants": {
        if (op.file !== batch.file) {
          fail(`op.file "${op.file}" does not match batch file "${batch.file}"`);
          break;
        }
        const info = findCvaCall(sourceFile, op.varName);
        if (!info) {
          fail(`no cva(...) call assigned to "${op.varName}" was found in ${op.file}`);
          break;
        }
        if (op.base !== undefined) {
          if (!info.baseArg) {
            fail(
              `"${op.varName}" has no existing base class-string argument — v1 cannot introduce one where there ` +
                `wasn't one before (that would change cva's call signature, not just a class string)`
            );
          } else if (!Node.isStringLiteral(info.baseArg)) {
            fail(`"${op.varName}"'s base argument is not a plain string literal — v1 can only merge into a literal string`);
          }
        }
        if (op.variants) {
          const existingKeys = cvaVariantKeys(info);
          for (const [group, options] of Object.entries(op.variants)) {
            if (!(group in existingKeys)) {
              fail(`variant group "${group}" does not exist on "${op.varName}" — cannot introduce a new group`);
              continue;
            }
            for (const optionName of Object.keys(options)) {
              if (!existingKeys[group]!.has(optionName)) {
                fail(
                  `variant option "${group}.${optionName}" does not exist on "${op.varName}" — cannot introduce a new option`
                );
                continue;
              }
              const valueNode = getVariantOptionInitializer(info, group, optionName);
              if (!valueNode || !Node.isStringLiteral(valueNode)) {
                fail(
                  `"${op.varName}" variant "${group}.${optionName}" is not a plain string literal — v1 can only ` +
                    `merge into a literal string`
                );
              }
            }
          }
        }
        break;
      }

      case "wrap_element": {
        if (op.address.file !== batch.file) {
          fail(`address.file "${op.address.file}" does not match batch file "${batch.file}"`);
          break;
        }
        const resolved = resolveAddress(sourceFile, op.address);
        if (!resolved.ok) fail(`address does not resolve: ${resolved.reason}`);
        break;
      }

      case "insert_presentational": {
        if (op.parentAddress.file !== batch.file) {
          fail(`parentAddress.file "${op.parentAddress.file}" does not match batch file "${batch.file}"`);
          break;
        }
        const resolved = resolveAddress(sourceFile, op.parentAddress);
        if (!resolved.ok) {
          fail(`parentAddress does not resolve: ${resolved.reason}`);
          break;
        }
        if (!isJsxCapable(resolved.node)) {
          fail(`parentAddress at ${addressKey(op.parentAddress)} is not a JSX element and cannot take children`);
          break;
        }
        if (Node.isJsxSelfClosingElement(resolved.node)) {
          fail(
            `parentAddress at ${addressKey(op.parentAddress)} is self-closing and has no body to insert into — v1 ` +
              `only inserts into an element or fragment that already has JSX children (converting a self-closing ` +
              `element into one with a body is a bigger structural change than this op is scoped for)`
          );
          break;
        }
        const childCount = countSignificantChildren(resolved.node);
        if (op.atIndex > childCount) {
          fail(
            `atIndex ${op.atIndex} is out of range — the parent currently has ${childCount} significant children (valid range is 0..${childCount})`
          );
        }
        const tagIsAllowlisted = (PRESENTATIONAL_INSERT_TAG_ALLOWLIST as readonly string[]).includes(op.tag);
        const tagIsImportedThisBatch = importedLocalNamesInBatch.has(op.tag);
        const tagIsAlreadyImported = existingImports.has(op.tag);
        if (!tagIsAllowlisted && !tagIsImportedThisBatch && !tagIsAlreadyImported) {
          fail(
            `tag "${op.tag}" is not a presentational element and isn't introduced by an add_import op in this batch, nor already imported in the file`
          );
        }
        break;
      }

      case "add_import": {
        if (op.file !== batch.file) {
          fail(`op.file "${op.file}" does not match batch file "${batch.file}"`);
          break;
        }
        if (existingImports.has(op.localName) || existingTopLevel.has(op.localName)) {
          fail(`localName "${op.localName}" is already bound in ${op.file} — pick a different local name`);
        }
        break;
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
