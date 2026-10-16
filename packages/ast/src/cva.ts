import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile, CallExpression, ObjectLiteralExpression } from "ts-morph";

/**
 * Shared ts-morph-side introspection of a `const X = cva(base?, { variants: {...} })`
 * call. Both the validator (task #18 — does this group/option name exist,
 * can this value even be rewritten) and the applier (task #19 — actually
 * rewrite it) need to find the exact same nodes, so this lives in one place
 * rather than being a third reimplementation alongside the Babel-based
 * `cvaVariantKeys()` in logicSkeleton.ts (which stays independent on
 * purpose — see that file's comments).
 */
export interface CvaCallInfo {
  call: CallExpression;
  /**
   * The base class-string argument — only present for the two-argument form
   * `cva("base classes", { variants: {...} })`. The single-argument form
   * `cva({ variants: {...} })` has no base slot at all; callers that need
   * to introduce one where there wasn't one before are out of v1 scope
   * (see validator.ts), so `undefined` here means exactly that.
   */
  baseArg: Node | undefined;
  /** The `variants: {...}` object literal, if the config arg declares one. */
  variantsObject: ObjectLiteralExpression | undefined;
}

export function findCvaCall(sourceFile: SourceFile, varName: string): CvaCallInfo | undefined {
  const varDecl = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((v) => v.getName() === varName);
  if (!varDecl) return undefined;

  const init = varDecl.getInitializer();
  if (!init || !Node.isCallExpression(init)) return undefined;
  if (init.getExpression().getText() !== "cva") return undefined;

  const args = init.getArguments();
  const hasBaseArg = args.length >= 2;
  const configArg = hasBaseArg ? args[1] : args[0];
  const baseArg = hasBaseArg ? args[0] : undefined;

  let variantsObject: ObjectLiteralExpression | undefined;
  if (configArg && Node.isObjectLiteralExpression(configArg)) {
    const variantsProp = configArg.getProperty("variants");
    if (variantsProp && Node.isPropertyAssignment(variantsProp)) {
      const variantsInit = variantsProp.getInitializer();
      if (variantsInit && Node.isObjectLiteralExpression(variantsInit)) variantsObject = variantsInit;
    }
  }

  return { call: init, baseArg, variantsObject };
}

/** group name -> option name set, read straight off the live tree. */
export function cvaVariantKeys(info: CvaCallInfo): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  if (!info.variantsObject) return result;
  for (const prop of info.variantsObject.getProperties()) {
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

/** The actual initializer node for one `variants.<group>.<option>` class
 * string, or undefined if the group/option doesn't exist on this call. */
export function getVariantOptionInitializer(info: CvaCallInfo, group: string, option: string): Node | undefined {
  if (!info.variantsObject) return undefined;
  const groupProp = info.variantsObject.getProperty(group);
  if (!groupProp || !Node.isPropertyAssignment(groupProp)) return undefined;
  const groupInit = groupProp.getInitializer();
  if (!groupInit || !Node.isObjectLiteralExpression(groupInit)) return undefined;
  const optionProp = groupInit.getProperty(option);
  if (!optionProp || !Node.isPropertyAssignment(optionProp)) return undefined;
  return optionProp.getInitializer();
}

/**
 * Every `cva(...)` call in a file, by the variable it's assigned to —
 * `findCvaCall` needs a `varName` up front (the validator and applier
 * always have one, named in the op itself), but the generator (Phase 4)
 * has to discover which variables in a file are cva calls at all before
 * it can do anything with them. Re-checks each candidate variable
 * declaration through `findCvaCall` rather than a separate tree walk —
 * one more tree walk per file is not worth a second implementation to
 * keep in sync with the first.
 */
export function findAllCvaCalls(sourceFile: SourceFile): { varName: string; info: CvaCallInfo }[] {
  const results: { varName: string; info: CvaCallInfo }[] = [];
  for (const varDecl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const varName = varDecl.getName();
    const info = findCvaCall(sourceFile, varName);
    if (info) results.push({ varName, info });
  }
  return results;
}
