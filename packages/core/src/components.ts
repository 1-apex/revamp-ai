import fg from "fast-glob";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSource } from "@revamp/ast";
import _traverse, { type Visitor } from "@babel/traverse";
import * as t from "@babel/types";
import { classifyRole, type ElementRole } from "./roles.js";

const traverse = ((_traverse as unknown as { default?: unknown }).default ?? _traverse) as (
  ast: t.Node,
  visitor: Visitor
) => void;

export interface ComponentInfo {
  file: string;
  relativePath: string;
  name: string;
  isRoute: boolean;
  isPrimitive: boolean;
  hooksUsed: string[];
  jsxTagsUsed: string[];
  roleCounts: Record<ElementRole, number>;
}

const SOURCE_GLOB = ["**/*.tsx", "**/*.jsx"];
const IGNORE_GLOB = ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/build/**", "**/*.test.*", "**/*.spec.*"];

export function listSourceFiles(rootDir: string): string[] {
  return fg.sync(SOURCE_GLOB, { cwd: rootDir, ignore: IGNORE_GLOB, absolute: true });
}

function looksLikeComponentName(name: string | undefined): name is string {
  return Boolean(name) && /^[A-Z]/.test(name!);
}

function isRoutePath(relativePath: string): boolean {
  return /(^|\/)(routes|pages|app)\//.test(relativePath) || /(^|\/)page\.tsx$/.test(relativePath);
}

function isPrimitivePath(relativePath: string): boolean {
  return /(^|\/)components\/ui\//.test(relativePath);
}

function jsxNameToString(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`;
  return `${jsxNameToString(name.object as any)}.${jsxNameToString(name.property)}`;
}

function calleeName(node: t.Expression): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && t.isIdentifier(node.property) && !node.computed) {
    const obj = calleeName(node.object as t.Expression);
    return obj ? `${obj}.${node.property.name}` : node.property.name;
  }
  return null;
}

function isHookName(name: string): boolean {
  const bare = name.includes(".") ? name.split(".").pop()! : name;
  return /^use[A-Z0-9]/.test(bare);
}

/** Scan one file for React components. A "component" here is any
 * top-level function whose name starts with a capital letter and whose
 * body contains at least one JSX element — good enough for this engine's
 * purposes without needing full type-flow analysis. */
export function scanComponentsInFile(file: string, rootDir: string): ComponentInfo[] {
  const source = readFileSync(file, "utf8");
  const relativePath = path.relative(rootDir, file);
  const ast = parseSource(source, file);
  const found: ComponentInfo[] = [];

  const makeEmptyRoleCounts = (): Record<ElementRole, number> => ({
    interactive: 0,
    text: 0,
    layout: 0,
    media: 0,
    component: 0,
    other: 0,
  });

  function analyzeFunctionBody(name: string, bodyPath: import("@babel/traverse").NodePath<t.Node>) {
    let containsJsx = false;
    const hooksUsed = new Set<string>();
    const jsxTagsUsed = new Set<string>();
    const roleCounts = makeEmptyRoleCounts();

    bodyPath.traverse({
      JSXElement(path) {
        containsJsx = true;
        const opening = path.node.openingElement;
        const tagName = jsxNameToString(opening.name);
        jsxTagsUsed.add(tagName);
        const attrNames = opening.attributes
          .filter((a): a is t.JSXAttribute => t.isJSXAttribute(a))
          .map((a) => jsxNameToString(a.name as any));
        const role = classifyRole(tagName, attrNames);
        roleCounts[role] += 1;
      },
      JSXFragment() {
        containsJsx = true;
      },
      CallExpression(path) {
        const name = calleeName(path.node.callee as t.Expression);
        if (name && isHookName(name)) hooksUsed.add(name);
      },
    });

    if (containsJsx) {
      found.push({
        file,
        relativePath,
        name,
        isRoute: isRoutePath(relativePath),
        isPrimitive: isPrimitivePath(relativePath),
        hooksUsed: [...hooksUsed].sort(),
        jsxTagsUsed: [...jsxTagsUsed].sort(),
        roleCounts,
      });
    }
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      // `export default function Foo() {}` is BOTH a FunctionDeclaration and
      // the declaration of an ExportDefaultDeclaration. The latter is handled
      // explicitly below — skip here so it is not counted as two components.
      if (t.isExportDefaultDeclaration(path.parent)) return;
      const name = path.node.id?.name;
      if (looksLikeComponentName(name)) analyzeFunctionBody(name, path.get("body"));
    },
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      if (
        t.isIdentifier(id) &&
        looksLikeComponentName(id.name) &&
        init &&
        (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init))
      ) {
        analyzeFunctionBody(id.name, (path.get("init") as any).get("body"));
      }
    },
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl)) {
        analyzeFunctionBody(decl.id?.name ?? deriveNameFromFile(relativePath), path.get("declaration").get("body"));
      }
    },
  });

  return found;
}

function deriveNameFromFile(relativePath: string): string {
  const base = path.basename(relativePath).replace(/\.(tsx|jsx)$/, "");
  return base;
}

export function scanAllComponents(rootDir: string): ComponentInfo[] {
  const files = listSourceFiles(rootDir);
  return files.flatMap((f) => scanComponentsInFile(f, rootDir));
}
