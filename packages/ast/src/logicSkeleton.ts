import { createHash } from "node:crypto";
import _traverse, { type NodePath, type Visitor } from "@babel/traverse";
import * as t from "@babel/types";
import { parseSource } from "./parse.js";

const traverse = ((_traverse as unknown as { default?: unknown }).default ?? _traverse) as (ast: t.Node, visitor: Visitor) => void;

/**
 * The logic-skeleton hash.
 *
 * Goal: capture everything about a component that is NOT presentation —
 * hooks and their order, event handlers, props, conditionals, data flow,
 * component identity — and hash it. Two files with the same skeleton hash
 * are, for the purposes of this engine's safety guarantee, "the same code
 * wearing different clothes."
 *
 * What is deliberately EXCLUDED (this is the whole point):
 *   - `className` / `class` / `style` attributes and everything inside them
 *   - the literal class-string arguments of a `cva(...)` call — but NOT its
 *     variant key names, which the validator treats as immutable structure
 *   - pure code formatting (whitespace, semicolons, quote style, line breaks)
 *
 * What is deliberately INCLUDED, because a bug here is exactly the class of
 * bug this whole engine exists to prevent:
 *   - hook calls, in order, with their dependency arrays
 *   - every other function call (callee + arg count)
 *   - JSX tag names (including custom component identity — swapping
 *     <Button> for <a> is a logic-relevant change, not a style one)
 *   - every non-presentational JSX attribute name, and its value if it's an
 *     expression (so changing `onClick={a}` to `onClick={b}` is caught)
 *   - variable/parameter names, member-expression chains, literals,
 *     conditionals, imports and exports
 *
 * Known v1 limitations (fine for Phase 0, worth hardening in Phase 1):
 *   - decorative wrapper elements (e.g. a bare `<div>` added purely to hold
 *     a class) are NOT pruned from the skeleton yet, so `wrap_element` will
 *     currently show up as a hash change. The applier should special-case
 *     this rather than the hash trying to guess "decorative" in general —
 *     see the build-order doc, Phase 1.
 *   - JSX spread attributes are recorded as a presence marker only; we do
 *     not attempt to resolve what's inside them.
 */

export interface LogicSkeleton {
  tokens: string[];
  hash: string;
}

const PRESENTATIONAL_ATTR_NAMES = new Set(["className", "class", "style"]);

function jsxNameToString(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`;
  // JSXMemberExpression, e.g. <Foo.Bar />
  return `${jsxNameToString(name.object as any)}.${jsxNameToString(name.property)}`;
}

function memberToDottedPath(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isThisExpression(node)) return "this";
  if (t.isMemberExpression(node) && !node.computed) {
    const obj = memberToDottedPath(node.object);
    const prop = t.isIdentifier(node.property) ? node.property.name : null;
    if (obj && prop) return `${obj}.${prop}`;
  }
  return null;
}

function calleeName(node: t.CallExpression["callee"]): string {
  if (t.isIdentifier(node)) return node.name;
  const dotted = memberToDottedPath(node);
  if (dotted) return dotted;
  return "expr";
}

function isHookName(name: string): boolean {
  const bare = name.includes(".") ? name.split(".").pop()! : name;
  return /^use[A-Z0-9]/.test(bare);
}

function idPatternNames(node: t.LVal | t.Identifier | t.ArrayPattern | t.ObjectPattern | null): string[] {
  if (!node) return [];
  if (t.isIdentifier(node)) return [node.name];
  if (t.isArrayPattern(node)) {
    return node.elements.flatMap((el) => (el ? idPatternNames(el as any) : ["_"]));
  }
  if (t.isObjectPattern(node)) {
    return node.properties.map((p) => {
      if (t.isObjectProperty(p) && t.isIdentifier(p.key)) return p.key.name;
      if (t.isRestElement(p) && t.isIdentifier(p.argument)) return `...${p.argument.name}`;
      return "?";
    });
  }
  if (t.isAssignmentPattern(node)) return idPatternNames(node.left as any);
  if (t.isRestElement(node)) return [`...${idPatternNames(node.argument as any).join(",")}`];
  return ["?"];
}

/** Extract `cva({ variants: { intent: {...}, size: {...} } })`-style variant
 * *keys* (group names + option names within each group) without touching
 * the class-string values themselves. Best-effort: unusual cva usage falls
 * back to a generic marker rather than throwing. */
function cvaVariantKeys(call: t.CallExpression): string {
  const configArg = call.arguments[1] ?? call.arguments[0];
  if (!configArg || !t.isObjectExpression(configArg)) return "cva:opaque";
  const variantsProp = configArg.properties.find(
    (p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "variants"
  );
  if (!variantsProp || !t.isObjectExpression(variantsProp.value)) return "cva:no-variants";
  const groups = variantsProp.value.properties
    .filter((p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key))
    .map((p) => {
      const groupName = (p.key as t.Identifier).name;
      const options = t.isObjectExpression(p.value)
        ? p.value.properties
            .filter((op): op is t.ObjectProperty => t.isObjectProperty(op) && t.isIdentifier(op.key))
            .map((op) => (op.key as t.Identifier).name)
            .sort()
        : [];
      return `${groupName}[${options.join(",")}]`;
    })
    .sort();
  return `cva:${groups.join("|")}`;
}

export function extractLogicSkeleton(source: string, filename: string): LogicSkeleton {
  const ast = parseSource(source, filename);
  const tokens: string[] = [];
  const push = (s: string) => tokens.push(s);

  const visitor: Visitor = {
    ImportDeclaration(path) {
      const specs = path.node.specifiers
        .map((s) => {
          if (t.isImportDefaultSpecifier(s)) return `default:${s.local.name}`;
          if (t.isImportNamespaceSpecifier(s)) return `*:${s.local.name}`;
          if (t.isImportSpecifier(s)) {
            const imported = t.isIdentifier(s.imported) ? s.imported.name : s.imported.value;
            return imported === s.local.name ? imported : `${imported} as ${s.local.name}`;
          }
          return "?";
        })
        .sort();
      push(`import:${path.node.source.value}:${specs.join(",")}`);
      path.skip();
    },

    ExportDefaultDeclaration(path) {
      push("export-default");
    },
    ExportNamedDeclaration(path) {
      const names = (path.node.specifiers || [])
        .map((s) => (t.isExportSpecifier(s) && t.isIdentifier(s.exported) ? s.exported.name : "?"))
        .sort();
      push(`export-named:${names.join(",")}`);
    },

    FunctionDeclaration(path) {
      const name = path.node.id?.name ?? "anonymous";
      const params = path.node.params.map((p) => idPatternNames(p as any).join("+")).join(",");
      push(`fn-decl:${name}(${params})`);
    },
    ArrowFunctionExpression(path) {
      const params = path.node.params.map((p) => idPatternNames(p as any).join("+")).join(",");
      push(`fn(${params})`);
    },
    FunctionExpression(path) {
      const params = path.node.params.map((p) => idPatternNames(p as any).join("+")).join(",");
      push(`fn(${params})`);
    },

    VariableDeclarator(path) {
      const init = path.node.init;
      if (init && t.isCallExpression(init) && calleeName(init.callee) === "cva") {
        const varName = t.isIdentifier(path.node.id) ? path.node.id.name : "anon";
        push(`cva-var:${varName}:${cvaVariantKeys(init)}`);
        path.get("init").skip();
        return;
      }
      push(`var:${idPatternNames(path.node.id as any).join(",")}`);
    },

    JSXOpeningElement(path) {
      push(`jsx-open:${jsxNameToString(path.node.name)}`);
    },
    JSXClosingElement(path) {
      // redundant with opening tag name; intentionally not tokenized
    },

    JSXAttribute(path) {
      const name = jsxNameToString(path.node.name as any);
      if (PRESENTATIONAL_ATTR_NAMES.has(name)) {
        path.skip();
        return;
      }
      push(`jsx-attr:${name}`);
      // do not skip — let the value (Identifier/CallExpression/Literal/etc.)
      // be visited normally so its own visitor records it
    },
    JSXSpreadAttribute(path) {
      const dotted = memberToDottedPath(path.node.argument);
      push(`jsx-spread:${dotted ?? "expr"}`);
      path.skip();
    },

    JSXText(path) {
      const text = path.node.value.trim().replace(/\s+/g, " ");
      if (text) push(`text:${text}`);
    },

    CallExpression(path) {
      const name = calleeName(path.node.callee);
      if (name === "cva") {
        // handled at the VariableDeclarator level when assigned; if a cva()
        // call shows up unassigned, still record its variant keys here.
        push(cvaVariantKeys(path.node));
        path.get("arguments").forEach((a) => a.skip());
        return;
      }
      if (isHookName(name)) {
        push(`hook:${name}:args=${path.node.arguments.length}`);
        const depsArg = path.node.arguments[1];
        if (depsArg && t.isArrayExpression(depsArg)) {
          const deps = depsArg.elements
            .map((el) => (el ? memberToDottedPath(el as any) ?? "expr" : "hole"))
            .sort();
          push(`hook-deps:${name}:${deps.join(",")}`);
        }
        return;
      }
      push(`call:${name}:args=${path.node.arguments.length}`);
    },

    MemberExpression(path) {
      if (path.node.computed) return; // let object + computed property tokenize normally
      const dotted = memberToDottedPath(path.node);
      if (dotted) {
        push(`member:${dotted}`);
        path.skip();
      }
    },

    ConditionalExpression() {
      push("cond");
    },
    LogicalExpression(path) {
      push(`logic:${path.node.operator}`);
    },
    BinaryExpression(path) {
      push(`binop:${path.node.operator}`);
    },
    IfStatement() {
      push("if");
    },

    StringLiteral(path) {
      // A whitespace-only string literal used as a JSX *child* (e.g. the
      // {" "} Prettier inserts when it wraps JSX text across a line break)
      // is exactly as presentational as the whitespace in a JSXText node.
      // Only a whitespace literal in this specific position is exempt —
      // one used as a real prop value or argument still counts.
      const isJsxChildWhitespace =
        path.node.value.trim() === "" &&
        t.isJSXExpressionContainer(path.parent) &&
        (t.isJSXElement(path.parentPath.parent) || t.isJSXFragment(path.parentPath.parent));
      if (isJsxChildWhitespace) return;
      push(`str:${path.node.value}`);
    },
    NumericLiteral(path) {
      push(`num:${path.node.value}`);
    },
    BooleanLiteral(path) {
      push(`bool:${path.node.value}`);
    },
    NullLiteral() {
      push("null");
    },
    TemplateLiteral(path) {
      push(`template:${path.node.quasis.map((q) => q.value.cooked ?? "").join("${}")}`);
    },

    Identifier(path) {
      // Skip positions already captured with more context elsewhere, to
      // reduce noise. Harmless if a few slip through and get double-counted
      // — determinism and sensitivity matter more than a minimal token set.
      const parent = path.parent;
      if (t.isImportSpecifier(parent) || t.isImportDefaultSpecifier(parent) || t.isImportNamespaceSpecifier(parent)) return;
      if (t.isJSXIdentifier(parent as any)) return;
      if (t.isMemberExpression(parent) && parent.property === path.node && !parent.computed) return;
      if (t.isFunctionDeclaration(parent) && parent.id === path.node) return;
      if (t.isVariableDeclarator(parent) && parent.id === path.node) return;
      push(`id:${path.node.name}`);
    },
  };

  traverse(ast, visitor);

  const hash = createHash("sha256").update(tokens.join("\n")).digest("hex");
  return { tokens, hash };
}

export function hashSource(source: string, filename: string): string {
  return extractLogicSkeleton(source, filename).hash;
}
