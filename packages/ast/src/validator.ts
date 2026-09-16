import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { resolveAddress, countSignificantChildren, addressKey } from "./addressing.js";
import { PRESENTATIONAL_INSERT_TAG_ALLOWLIST, type EditOp, type EditBatch } from "./editOps.js";

/**
 * The validator — everything about "is this batch legal" that needs the
 * actual file content to answer, which is exactly what the schema (Phase
 * 1, task #17) couldn't check on its own. `editOps.ts` already rejects a
 * structurally invalid op; this module rejects a structurally valid op
 * that doesn't match reality: an address that no longer resolves, a cva
 * variant name that was never there, an import name already taken.
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

/** The current variant group -> option-name set for a `cva(...)` call
 * assigned to `varName`, read straight from the ts-morph tree (this is a
 * separate, independent read from the Babel-based `cvaVariantKeys()` in
 * logicSkeleton.ts — same invariant, two toolchains, on purpose, same as
 * the rest of this engine). Returns undefined if no such cva call exists;
 * returns an empty object if it exists but declares no `variants`.
 */
function findCvaVariantKeys(sourceFile: SourceFile, varName: string): Record<string, Set<string>> | undefined {
  const varDecl = sourceFile
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((v) => v.getName() === varName);
  if (!varDecl) return undefined;

  const init = varDecl.getInitializer();
  if (!init || !Node.isCallExpression(init)) return undefined;
  if (init.getExpression().getText() !== "cva") return undefined;

  const args = init.getArguments();
  const configArg = args[1] ?? args[0];
  if (!configArg || !Node.isObjectLiteralExpression(configArg)) return {};

  const variantsProp = configArg.getProperty("variants");
  if (!variantsProp || !Node.isPropertyAssignment(variantsProp)) return {};

  const variantsInit = variantsProp.getInitializer();
  if (!variantsInit || !Node.isObjectLiteralExpression(variantsInit)) return {};

  const result: Record<string, Set<string>> = {};
  for (const prop of variantsInit.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const groupName = prop.getName();
    const options = new Set<string>();
    const groupInit = prop.getInitializer();
    if (groupInit && Node.isObjectLiteralExpression(groupInit)) {
      for (const optionProp of groupInit.getProperties()) {
        if (Node.isPropertyAssignment(optionProp)) options.add(optionProp.getName());
      }
    }
    result[groupName] = options;
  }
  return result;
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
        }
        break;
      }

      case "set_cva_variants": {
        if (op.file !== batch.file) {
          fail(`op.file "${op.file}" does not match batch file "${batch.file}"`);
          break;
        }
        const existingKeys = findCvaVariantKeys(sourceFile, op.varName);
        if (!existingKeys) {
          fail(`no cva(...) call assigned to "${op.varName}" was found in ${op.file}`);
          break;
        }
        if (op.variants) {
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
