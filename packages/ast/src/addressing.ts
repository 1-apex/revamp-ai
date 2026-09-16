import { Project, Node, SyntaxKind, ts } from "ts-morph";
import type {
  SourceFile,
  FunctionDeclaration,
  ArrowFunction,
  FunctionExpression,
  JsxElement,
  JsxSelfClosingElement,
  JsxFragment,
} from "ts-morph";

/**
 * Node addressing — the part of this engine most likely to grow bugs if
 * rushed, per the build order. The rule that keeps it safe is not clever
 * path math: it's re-verifying the fingerprint every time and refusing to
 * guess when it doesn't match.
 *
 * Deliberate v1 scope cut (documented, not hidden): an address only
 * reaches JSX that is a *positional* descendant of a component's own
 * return value — the direct `<div><Card/></div>` kind of nesting. JSX
 * produced inside a callback (`.map(v => <Card/>)`, a ternary branch that
 * itself contains further JSX-in-a-callback, etc.) is not enumerated as
 * addressable yet. That JSX still exists and still renders; this engine
 * just can't target it with an edit-op until the addressing scheme grows
 * a notion of "inside this specific callback." Extending it is Phase 1b
 * work, not a correctness bug in what's here.
 */

export interface EditAddress {
  file: string;
  component: string;
  /** which JSX-yielding return point in the component, in source order */
  root: number;
  /** descent by index among the target's significant (non-whitespace) siblings */
  path: number[];
}

export function addressKey(addr: EditAddress): string {
  return `${addr.file}::${addr.component}::${addr.root}::${addr.path.join(".")}`;
}

export interface AddressableNode {
  address: EditAddress;
  fingerprint: string;
  node: Node;
}

type JsxNode = JsxElement | JsxSelfClosingElement | JsxFragment;

function isJsxNode(node: Node): node is JsxNode {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

function unwrapParens(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

/** Children worth assigning a path index to. A JsxText node that is pure
 * whitespace is formatting, not structure — Prettier adds and removes
 * these constantly, so counting them would make addresses shift on every
 * reformat. Everything else (elements, fragments, expressions, and any
 * JsxText with real content) counts. */
function getSignificantChildren(node: JsxNode): Node[] {
  if (Node.isJsxSelfClosingElement(node)) return [];
  const children = node.getJsxChildren();
  return children.filter((c) => {
    if (Node.isJsxText(c)) return c.getText().trim().length > 0;
    return true;
  });
}

function tagNameOf(node: JsxNode): string {
  if (Node.isJsxFragment(node)) return "<>";
  if (Node.isJsxSelfClosingElement(node)) return node.getTagNameNode().getText();
  return node.getOpeningElement().getTagNameNode().getText();
}

/** JsxElement keeps its attributes on the opening tag; JsxSelfClosingElement
 * carries them directly. Fragments have none. Normalizing here means every
 * other function can just ask "what are this node's attribute names." */
function attributeNamesOf(node: JsxNode): string[] {
  if (Node.isJsxFragment(node)) return [];
  const attrs = Node.isJsxSelfClosingElement(node) ? node.getAttributes() : node.getOpeningElement().getAttributes();
  return attrs.map((a: Node) => (Node.isJsxAttribute(a) ? a.getNameNode().getText() : "{...spread}"));
}

function childKindLabel(node: Node): string {
  if (isJsxNode(node)) return `element:${tagNameOf(node)}`;
  if (Node.isJsxExpression(node)) return "expr";
  if (Node.isJsxText(node)) return "text";
  return `other:${node.getKindName()}`;
}

const PRESENTATIONAL_ATTR_NAMES = new Set(["className", "class", "style"]);

/** tag + non-presentational attribute names + shallow child shape. Not a
 * hash of everything — just enough that "this is still the node I meant"
 * survives styling churn but not a real structural change. */
export function computeFingerprint(node: Node): string {
  if (isJsxNode(node)) {
    const tag = tagNameOf(node);
    const attrNames = attributeNamesOf(node)
      .filter((n) => !PRESENTATIONAL_ATTR_NAMES.has(n))
      .sort();
    const childKinds = getSignificantChildren(node).map(childKindLabel);
    return `element:${tag}:[${attrNames.join(",")}]:children[${childKinds.join(",")}]`;
  }
  if (Node.isJsxExpression(node)) return "expr";
  if (Node.isJsxText(node)) return "text";
  return `other:${node.getKindName()}`;
}

function findComponentFunction(
  sourceFile: SourceFile,
  componentName: string
): FunctionDeclaration | ArrowFunction | FunctionExpression | undefined {
  const fnDecl = sourceFile
    .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
    .find((f) => f.getName() === componentName);
  if (fnDecl) return fnDecl;

  const varDecl = sourceFile
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((v) => v.getName() === componentName);
  if (varDecl) {
    const init = varDecl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  return undefined;
}

/** Every JSX-yielding return point in a function, in source order, but
 * only ones that belong to THIS function — not to a nested callback. */
function findRoots(fn: FunctionDeclaration | ArrowFunction | FunctionExpression): Node[] {
  const body = fn.getBody();
  if (!body) return [];

  if (Node.isBlock(body)) {
    const returns = body
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((r) => r.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a)) === fn);
    const roots: Node[] = [];
    for (const r of returns) {
      const expr = r.getExpression();
      if (!expr) continue;
      const unwrapped = unwrapParens(expr);
      if (isJsxNode(unwrapped)) roots.push(unwrapped);
    }
    return roots;
  }

  // concise-body arrow, e.g. `() => <div>...</div>`
  const unwrapped = unwrapParens(body);
  return isJsxNode(unwrapped) ? [unwrapped] : [];
}

/** Walk one root, assigning a path (array of indices) to every JSX-shaped
 * descendant reachable by pure positional descent. */
function walk(root: Node, rootIndex: number, file: string, component: string, out: AddressableNode[]) {
  function recurse(node: Node, path: number[]) {
    out.push({
      address: { file, component, root: rootIndex, path },
      fingerprint: computeFingerprint(node),
      node,
    });
    if (!isJsxNode(node)) return;
    const children = getSignificantChildren(node);
    children.forEach((child, i) => recurse(child, [...path, i]));
  }
  recurse(root, []);
}

/** Public wrapper for the validator (Phase 1, task #18): how many
 * significant children a resolved node currently has, so an
 * insert_presentational op's `atIndex` can be range-checked without that
 * caller needing to know how "significant" is defined here. Returns 0 for
 * anything that isn't a JSX container (including a self-closing element,
 * which by definition has none). */
export function countSignificantChildren(node: Node): number {
  if (!isJsxNode(node)) return 0;
  return getSignificantChildren(node).length;
}

export function enumerateAddressableNodes(sourceFile: SourceFile, componentName: string): AddressableNode[] {
  const fn = findComponentFunction(sourceFile, componentName);
  if (!fn) return [];
  const roots = findRoots(fn);
  const out: AddressableNode[] = [];
  roots.forEach((root, i) => walk(root, i, sourceFile.getFilePath(), componentName, out));
  return out;
}

export interface ResolveResult {
  ok: true;
  node: Node;
  fingerprint: string;
}
export interface ResolveFailure {
  ok: false;
  reason: string;
}

/** Re-locate an address in the CURRENT state of a file and recompute its
 * fingerprint. This is the function every op validator calls before doing
 * anything else — resolving is cheap and re-checking every time is what
 * makes "the file changed since you looked at it" a loud, immediate
 * failure instead of a silent corruption three files later. */
export function resolveAddress(sourceFile: SourceFile, address: EditAddress): ResolveResult | ResolveFailure {
  const fn = findComponentFunction(sourceFile, address.component);
  if (!fn) return { ok: false, reason: `component "${address.component}" not found in ${address.file}` };
  const roots = findRoots(fn);
  const root = roots[address.root];
  if (!root) {
    return {
      ok: false,
      reason: `root #${address.root} not found in component "${address.component}" (it now has ${roots.length} JSX-yielding return point(s))`,
    };
  }

  let current: Node = root;
  for (const index of address.path) {
    if (!isJsxNode(current)) {
      return { ok: false, reason: `path descends into a non-JSX node before exhausting the address` };
    }
    const children = getSignificantChildren(current);
    const next = children[index];
    if (!next) {
      return {
        ok: false,
        reason: `child index ${index} out of range (node now has ${children.length} significant children) — the file has structurally changed since this address was recorded`,
      };
    }
    current = next;
  }

  return { ok: true, node: current, fingerprint: computeFingerprint(current) };
}

export function loadSourceFile(project: Project, filePath: string, sourceText: string) {
  const existing = project.getSourceFile(filePath);
  if (existing) existing.forget();
  return project.createSourceFile(filePath, sourceText, { overwrite: true });
}

export function createInMemoryProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
    },
  });
}
