# Revamp Engine

An MCP server and skill pack that gives a React codebase a distinctive,
coherent, accessible UI — under a hard guarantee that not one line of
application logic changes.

Full spec and 9-phase build order (design docs, not code) were written
before this repo existed; this repo is Phase 0 and Phase 1 of that plan,
actually built and tested, not just described. See `docs/` (gitignored,
local-only — not part of this repo's history) for the long-form writeup of
each phase: what was built, why specific decisions were made, and what was
found and fixed along the way.

**Status: Phase 0 and Phase 1 complete, Phase 2 in progress.** Phase 0 is
the safety instrument everything else gets built on: a way to scan a React
project and prove, with a hash, that a later change did or didn't touch
its logic. Phase 1 is the edit-op safety layer built on top of it: node
addressing, a zod-validated five-op schema, a validator, and a `ts-morph`
applier with `tailwind-merge` class normalization that actually lands an
edit and proves the result still honors whichever guarantee that op
belongs to. Phase 2 is the integration layer: a second fixture and
`revamp apply`/`revamp addresses` on the CLI are done; the MCP server is
next. There is still no design system generator yet.

## What's here

```
packages/
  ast/     the safety layer.
             - logicSkeleton.ts — the logic-skeleton hash: parses a file
               (Babel), strips everything presentational (className,
               style, cva's class strings), hashes what's left (hooks,
               handlers, props, conditionals, data flow, component
               identity, imports). Two files with the same hash are "the
               same code wearing different clothes."
             - addressing.ts — node addressing (ts-morph): gives every JSX
               element in a component a stable address (file ::
               component :: which return-JSX :: positional path) and a
               fingerprint (tag + non-presentational attribute names +
               shallow child shape). `resolveAddress` re-locates an
               address against the CURRENT state of a file and recomputes
               its fingerprint, aborting rather than guessing the moment
               the file has structurally changed underneath it.
             - editOps.ts — five zod-validated op shapes a host agent is
               allowed to request: `set_class_list`, `set_cva_variants`,
               `wrap_element`, `insert_presentational`, `add_import`.
             - cva.ts — shared `ts-morph` lookup of a `cva(...)` call's
               base/variants, used by both the validator and the applier
               so there's exactly one place that finds those nodes.
             - validator.ts — everything about "is this batch legal" that
               needs real file content: do addresses still resolve, is a
               className/cva value actually a plain string literal
               (never guesses at a dynamic expression), does a batch's
               single allowed structural op collide with another op's
               address.
             - applier.ts — actually lands a validated batch: mutates the
               `ts-morph` tree per op (merging class strings through
               `tailwind-merge`), then gates the result — byte-for-byte
               hash equality for hash-preserving ops, an exact-allowlisted
               token-diff for the one structure-extending op and any
               `add_import`s — reverting the whole batch on any failure.
  core/    the scanner — detects the stack (React version, Tailwind v4,
           shadcn/ui), finds every component and route, classifies JSX
           elements by role, and infers a product brief from
           package.json / README / route names. Never writes anything.
  cli/     three commands, together the harness every phase gets tested
           against without needing an AI in the loop:
             - `revamp scan <path>` — prints what core+ast find.
             - `revamp addresses <file> <component>` — lists every
               addressable JSX node ({root, path} + fingerprint) in one
               component. The only way to discover the exact values an
               edit batch's address fields need, short of reading
               `addressing.ts`'s output in a debugger.
             - `revamp apply <batchFile>` — validates and applies an edit
               batch (a JSON file shaped like `{file, ops}`). Dry-run by
               default (prints a unified diff via the `diff` package,
               writes nothing); `--write` actually lands it. `--json` on
               any command prints the raw result instead of a summary.
fixtures/
  fleet-dashboard/   one hand-authored React + Tailwind v4 + shadcn-style
                     fixture (a dashboard with real hooks, real handlers,
                     real conditional rendering, three JSX-yielding return
                     branches, and a `.map()` callback) to scan, hash,
                     address, validate, and apply edits against.
  inventory-panel/   a second hand-authored fixture, deliberately shaped to
                     hit patterns the first one doesn't: a
                     `React.memo(React.forwardRef(...))` double-wrapped
                     primitive, a single-argument `cva({...})` call (no
                     base string), a named (non-default) export page under
                     `pages/` instead of `routes/`, and JSX nested inside a
                     ternary's branches rather than only an early `return`.
                     Adding it is what surfaced a real scanner/addressing
                     gap (forwardRef components were invisible) by *using*
                     the existing fixture, not by reading the code — see
                     "What was actually found and fixed" below.
```

## Try it

```
npm install
npm run build
node packages/cli/dist/bin/revamp.js scan ./fixtures/fleet-dashboard
```

Run the safety tests — these ARE the Phase 0/1 stop-and-checks from the
build plan, not a separate afterthought:

```
cd packages/ast && npx vitest run
cd packages/core && npx vitest run
```

88 tests across six files (83 in `@revamp/ast`, 5 in `@revamp/core`), and
each one is a specific claim, not a vague "it works":

**`logicSkeleton.test.ts` (8 tests) — the hash:**
- Prettier reformatting (default config, and a very different one —
  narrow width, no semicolons, single quotes) never moves the hash
- an edit to `className` alone never moves the hash
- rewiring a button's `onClick` to a different handler always moves it
- changing a `useEffect` dependency array always moves it
- reordering two independent `useState` calls always moves it
- the hash is deterministic (same input, same output, always)

**`addressing.test.ts` (16 tests) — node addressing:**
- enumeration finds exactly the three JSX-yielding return points in the
  fixture (the error branch, the loading branch, the main content)
- enumeration never reaches JSX produced inside a `.map()` callback — a
  documented v1 scope cut, proven empirically rather than just asserted
- every enumerated address re-resolves against the same file with a
  matching fingerprint
- a `className`-only edit leaves a resolved address's fingerprint
  unchanged (presentational churn is tolerated)
- finds and re-resolves JSX inside a `React.forwardRef(...)`-wrapped
  component, and recurses through a doubly-wrapped
  `React.memo(React.forwardRef(...))` one, but still aborts for a wrapper
  name outside that small allowlist (a custom HOC)
- against the second fixture (`inventory-panel`): finds a named,
  non-default export's single root, never enumerates JSX nested inside a
  ternary's branches (the same scope cut as `.map()`, now proven against a
  second shape of the same gap), and still enumerates the sibling content
  that sits outside the ternary, unaffected by it
- removing a child DOES change the parent's fingerprint (structural
  changes are caught, not silently absorbed)
- an out-of-range child index, a vanished root, and an unknown component
  name each abort with a clear reason instead of resolving to the wrong
  node or throwing

**`editOps.test.ts` (16 tests) — the edit-op schema:**
- all five op shapes parse when their payload is valid
- an op whose `op` field isn't one of the five known strings is rejected
- `wrap_element` rejects a `wrapperTag` outside the allowlist (a real
  element like `button`, not just a nonsense string)
- `insert_presentational` rejects anything shaped like an event handler,
  and separately rejects an attribute name that isn't on the
  presentational allowlist even if it isn't handler-shaped (e.g. `href`)
- `add_import` rejects a source outside the allowlist, accepts one under
  an allowlisted prefix (`@/components/ui/*`), and rejects a `localName`
  that isn't a valid identifier
- `set_cva_variants` rejects an op that would change nothing
- a negative path index in an address is rejected
- `parseEditBatch` accepts a batch of mixed ops and rejects an empty one

**`validator.test.ts` (28 tests) — semantic checks against real file content:**
- `set_class_list` accepts a resolving address and rejects one that
  doesn't, rejects a resolving address that points at a Fragment (nowhere
  to put a className), rejects an existing className that's a dynamic
  expression like `cn(...)` rather than a plain string (the real fixture's
  own `Badge` component), and accepts a node with no className yet
- `set_cva_variants` accepts changing an existing group/option's class
  string, rejects an unknown `varName`, a brand-new group, or a brand-new
  option within an otherwise-real group, rejects introducing a `base`
  where the call has none (the single-argument `cva({...})` form), and
  rejects a variant value that isn't a plain string literal
- `wrap_element` accepts a resolving address
- `insert_presentational` accepts an allowlisted tag at a valid index,
  rejects an out-of-range `atIndex`, accepts a tag introduced by an
  `add_import` earlier in the same batch, accepts a tag that's already
  imported in the file from a prior run, rejects a tag that's none of
  those three, and rejects a self-closing parent (no body to insert into)
- `add_import` accepts a fresh `localName`, and rejects one that collides
  with an existing import, an existing top-level declaration, or another
  `add_import` op in the same batch
- an op whose `address.file`/`file` doesn't match the batch's file is
  rejected; a batch with two broken ops reports two errors, not just the
  first one
- a batch may contain at most one structure-extending op, and no *other*
  op in the same batch may address something inside the subtree that op
  is about to restructure (wrapping a node, or inserting before a sibling
  at or after the insertion index) — proven with cases that are rejected
  and a case that's still accepted (an unrelated op, untouched by the
  one structural op, lands fine)

**`applier.test.ts` (15 tests) — the mutator and its two gates:**
- `set_class_list` merges old+new classes through `tailwind-merge` (a
  conflicting utility resolves to the new one), adds a className where
  there wasn't one, never moves the logic-skeleton hash, and reverts the
  `SourceFile`'s own text when validation fails
- `set_cva_variants` merges base and per-option class strings and leaves
  variant key names untouched; fails rather than guessing when the target
  value isn't a plain string literal
- `wrap_element` moves the wrapped node verbatim into a new wrapper; its
  own test confirms this *does* move the logic-skeleton hash (the
  documented Phase 0 limitation) while still passing the narrower
  token-diff gate
- `insert_presentational` inserts a self-closing presentational leaf at
  the requested position with exactly the allowlisted new tokens, and
  fails on an out-of-range `atIndex` against the live tree
- `add_import` adds a default import and a named (optionally aliased)
  import
- a batch mixing a hash-preserving op with the one allowed structural op
  applies cleanly under the token-diff gate; two structural ops in one
  batch are rejected by the validator before anything is mutated

**`@revamp/core`'s `components.test.ts` (5 tests) — this package's first
test file, added alongside the forwardRef fix below:**
- finds a `React.forwardRef((props, ref) => ...)` component in the real
  `fleet-dashboard` fixture, and a doubly-wrapped
  `React.memo(React.forwardRef(...))` one
- still ignores a lowercase-named variable even if it's forwardRef-wrapped
  (not a component), and doesn't unwrap an arbitrary call — only the
  `forwardRef`/`memo` allowlist, never a custom HOC
- `scanAllComponents` against the real fixture finds all seven components
  (one route, six primitives) — six, not five, now that `Button` is
  counted

If any of the "never moves" / "tolerated" tests goes red, the fix is in
the hash or the fingerprint, never in the test. If a "always moves" /
"aborts" test goes red, something stopped being sensitive to a real bug
class, which is worse than a build failure.

## What was actually found and fixed while building this (kept here on
purpose, not swept away — this is what "tested," not just "written," means)

1. **Prettier's `{" "}` whitespace-preservation quirk.** At narrow print
   widths, Prettier turns implicit JSX whitespace into an explicit
   `{" "}` expression container. The hash originally treated that as content
   (since it's a string literal, not a JSXText node) and failed the
   "formatting never moves the hash" test. Fixed by treating a
   whitespace-only string literal in JSX-child position the same as
   whitespace in JSXText — it's presentation either way, human-written or
   Prettier-inserted.
2. **A duplicate-component bug in the scanner.** `export default function
   Foo() {}` is both a `FunctionDeclaration` and the declaration of an
   `ExportDefaultDeclaration`; the traversal was visiting it as both,
   double-counting every default-exported route.
3. **A `require()` inside an ES module.** `findFilesShallow` (used for
   Tailwind theme file and shadcn `components.json` detection) called
   `require("node:fs")` at runtime. That happened to work when tested via
   `node -e` (which defaults to a CommonJS context) and threw
   `ReferenceError: require is not defined` the moment it ran as part of
   the real ESM module graph — i.e. via the actual CLI. It silently
   swallowed the error and returned "not found" for everything. This is
   exactly the kind of bug that "worked when I tried it" and would have
   shipped broken; the fix was a static `import { statSync }` instead.
4. **ts-morph's real API didn't match the addressing draft's guesses.**
   Written against assumed names before ever compiling against ts-morph,
   `addressing.ts` had four mismatches: `ArrowFunctionExpression` isn't
   exported (it's `ArrowFunction`); `getTagNameNode()` and `getAttributes()`
   live on `JsxOpeningElement`, not on `JsxElement` itself (a `JsxElement`
   has to go through `.getOpeningElement()` first — only
   `JsxSelfClosingElement` carries them directly); and the guard for a
   `{...}` JSX expression is `Node.isJsxExpression`, not
   `Node.isJsxExpressionContainer`. None of these were guessable from
   memory — `tsc` caught all four on the first real build.
5. **`loadSourceFile`'s "forget the old node, create a new one" semantics
   is a footgun for anything that holds onto an earlier `SourceFile`
   handle.** Loading a second version of the same file path into the same
   `ts-morph` `Project` calls `.forget()` on whatever was there before,
   which invalidates every `Node` obtained from that earlier handle —
   touching one throws `InvalidOperationError: Attempted to get
   information from a node that was removed or forgotten`, not just "gives
   stale data." Found because the addressing smoke test reused an old
   `SourceFile` reference after loading two mutated versions over the same
   path in the same project. **Rule the applier follows because of this:
   never hold a `SourceFile`/`Node` reference across a reload of its own
   path in the same project — re-fetch and re-resolve against the file
   that was just loaded, every time.** This is exactly the discipline
   `resolveAddress` already enforces by design (never reuse an old
   resolution result); the bug was in test code that skipped it, not in
   `addressing.ts` itself, but it's exactly the class of mistake the
   applier (`applier.ts`, built after this was found) was written not to
   make — every op re-resolves its address against the live `sourceFile`
   immediately before touching it, never a cached `Node`.
6. **`path.get(childKey).skip()` doesn't actually skip, in this Babel
   version — only `path.skip()` on the path a visitor is CURRENTLY
   entering does.** `logicSkeleton.ts`'s whole cva exclusion (the one
   `set_cva_variants`'s entire hash-preserving guarantee rests on) was
   built on the first form: `path.get("init").skip()` from inside
   `VariableDeclarator`, and `path.get("arguments").forEach(a =>
   a.skip())` from inside `CallExpression`. Both looked right, both
   compiled, and both were silent no-ops — a cva call's base and variant
   class strings were leaking into the hash as ordinary `str:` tokens the
   whole time, undetected because no existing test exercised a file with
   a real `cva()` call end-to-end. Found by direct repro while wiring the
   applier's hash-preserving gate up to the real `badge.tsx` fixture: a
   `set_cva_variants` batch that should have been a no-op against the
   hash wasn't. Fixed by calling `.skip()` on the node's own path from
   inside its own visitor instead of pre-skipping a child fetched via
   `.get()`. This is exactly the project's own stated risk model playing
   out — "a bug here is exactly the class of bug this whole engine exists
   to prevent" — except the bug was in the exclusion, not the inclusion:
   it wasn't hiding a real logic change, it was *hiding too little*,
   making the hash stricter (and `set_cva_variants` falsely rejected as
   logic-changing) rather than unsafe. Still a bug worth finding before
   Phase 2 builds an MCP server on top of a guarantee that didn't hold.
7. **`forwardRef`-wrapped components — the standard shape for essentially
   every real shadcn/ui primitive — were entirely invisible to the scanner
   and to node addressing.** `const Button = React.forwardRef((props, ref)
   => {...})` has its render function nested inside a `CallExpression`
   argument, not sitting directly in the `VariableDeclarator`'s `init`;
   both `components.ts`'s component-finding traversal and
   `addressing.ts`'s `findComponentFunction` only matched an arrow/function
   expression assigned *directly*. Found not by code review but by using
   the project's own existing fixture while adding a second one: `revamp
   scan ./fixtures/fleet-dashboard` had always reported 5 shadcn
   primitives and never fingerprinted `button.tsx` at all, for a component
   that has been sitting in the fixture since Phase 0. `Button` wasn't an
   edge case nobody had tried — it was the fixture's own `Button`,
   unexercised because nothing before Phase 2 happened to call
   `enumerateAddressableNodes` or `scanAllComponents` with that specific
   component name and actually check the result. Fixed by a small,
   recursive unwrap (`forwardRef`/`React.forwardRef`/`memo`/`React.memo`
   only — a fixed allowlist, not "any call wrapping a function", since
   there's no general way to know an arbitrary HOC doesn't change a
   component's shape) added independently to both `components.ts` and
   `addressing.ts`, since the two have never shared this kind of
   AST-walking logic. `@revamp/core` got its first test file
   (`components.test.ts`) directly out of this fix.

## Environment note

Installing packages from inside the sandboxed dev VM this session used
(`device_bash`) required `npm config set strict-ssl false`, because that
VM's outbound traffic goes through a local MITM proxy for its own traffic
inspection and npm's proxy-agent doesn't pick up the proxy's CA the way
curl does. That's specific to this sandbox — installing in a normal
terminal on this machine should not need it.

## Phase 1 scope cuts (deliberate, documented, not accidental gaps)

Each of these is enforced and tested, not just a comment promising future
care — see `docs/phase-1-edit-safety-layer.md` for the full reasoning:

- **At most one structure-extending op (`wrap_element` /
  `insert_presentational`) per batch.** `insert_presentational` shifts
  sibling indices from its insertion point on; `wrap_element` replaces
  whatever is at its own address and pushes that subtree one level
  deeper. Either can silently invalidate — or worse, silently retarget —
  another op's address if both ran against addresses computed against the
  same pre-batch tree. Capping a batch at one structural op, plus a
  check that no other op in the batch addresses something inside the
  subtree that op restructures, closes the whole class rather than trying
  to detect each case after the fact.
- **`set_class_list` / `set_cva_variants` only rewrite a plain string
  literal.** A dynamic className (`cn(...)`, a template literal, a
  ternary — the real fixture's own `Badge` component does this) is left
  alone; the validator rejects the op rather than the applier guessing
  what a safe rewrite would mean.
- **`insert_presentational` requires a parent that already has a JSX
  body.** A self-closing element (`<img />`) has nowhere to insert a
  child without converting it into a non-self-closing element first —
  out of scope for an op whose whole point is "never a structural
  surprise."
- Carried over from Phase 0: the logic-skeleton hash does not prune
  decorative wrapper elements, so `wrap_element` registers as a hash
  change by design — which is exactly why it has its own narrower
  guarantee (every old token preserved in order, only the wrapper's own
  `jsx-open` token added) instead of being held to hash equality.
- Carried over from Phase 0's addressing: an address only reaches JSX
  that is a positional descendant of a component's own return value. JSX
  produced inside a `.map()` callback isn't addressable yet — Phase 1b
  work if it turns out to matter in practice.

## Next (Phase 2 — see the build-order doc)

Phase 0 and Phase 1 are both done and tested: scan → hash → address →
validate → apply, with two fixtures now exercised end-to-end at every
layer. What's left in Phase 2, in the order being built:

- ~~a second fixture~~ **done** (`fixtures/inventory-panel/`) — chosen
  specifically to hit patterns `fleet-dashboard` doesn't (see "What's
  here" above), which is what surfaced the `forwardRef` bug in the
  "found and fixed" list. Hand-authored rather than a vendored real
  open-source repo, on purpose: no licensing/attribution surface, no
  network dependency, and every pattern it exercises is a deliberate,
  named choice rather than whatever a real repo happened to contain.
- ~~`revamp apply` on the CLI~~ **done**: dry-run diff by default
  (rendered with the `diff` package — a presentation-only dependency;
  the actual safety gate stays the hand-rolled, tested logic in
  `applier.ts`), `--write` to commit, `--json` for the raw result. Proven
  end-to-end by hand against both fixtures: a hash-preserving
  `set_class_list`, a structure-extending `wrap_element`, a batch
  rejected by the validator (bad address), and a batch rejected by the
  schema (bad `wrapperTag`) — each one checked for the right diff, the
  right exit code, and that nothing was written when it shouldn't be.
  Came with a companion command, `revamp addresses <file> <component>`,
  added because there was no other way to discover the `{root, path}`
  values a batch's address fields need without reading `addressing.ts`'s
  output in a debugger — without it, `apply` couldn't be used end-to-end
  by a human at all. See docs/phase-2-fixtures-apply-and-mcp.md for the
  full design writeup (path normalization, why a diff library here but
  not in `applier.ts`, the CLI's own test-by-hand philosophy).
- the MCP server that actually surfaces `scanProject` /
  `enumerateAddressableNodes` / `parseEditBatch` / `validateEditBatch` /
  `applyEditBatch` as tools a host agent can call, instead of only being
  reachable by importing `@revamp/ast` / `@revamp/core` directly, or by a
  human typing `revamp apply` — **next**
- the design-system generator — this repo doesn't have one yet; everything
  so far is the safety layer a generator's output would need to pass
  through; not part of this phase
