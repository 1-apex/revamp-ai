# Revamp Engine

An MCP server and skill pack that gives a React codebase a distinctive,
coherent, accessible UI — under a hard guarantee that not one line of
application logic changes.

Full spec and 9-phase build order (design docs, not code) were written
before this repo existed; this repo is Phase 0 through Phase 4 of that
plan, actually built and tested, not just described. See `docs/`
(gitignored, local-only — not part of this repo's history) for the
long-form writeup of each phase: what was built, why specific decisions
were made, and what was found and fixed along the way.

**Status: Phase 0 through Phase 4 complete.** Phase 0 is the safety
instrument everything else gets built on: a way to scan a React project
and prove, with a hash, that a later change did or didn't touch its
logic. Phase 1 is the edit-op safety layer built on top of it: node
addressing, a zod-validated five-op schema, a validator, and a `ts-morph`
applier with `tailwind-merge` class normalization that actually lands an
edit and proves the result still honors whichever guarantee that op
belongs to. Phase 2 is the integration layer: a second fixture,
`revamp apply`/`revamp addresses` on the CLI, and an MCP server
(`@revamp/mcp`) that surfaces the same four operations — scan, list
addresses, validate, apply — as tools a host agent calls directly, over
stdio, instead of only reachable by importing the packages or shelling
out to the CLI. Phase 3 is the AI-driven skill pack this project's own
one-line description promised (`/revamp`). Phase 4 is that skill's
deterministic sibling: `@revamp/generator` picks a design direction with
no AI involved (three named presets, chosen by matching the product brief
against operational/consumer signal words) and mechanically re-hues
colors and normalizes radius values across a project — fully
unit-tested, every generated batch proven against the real
`validateEditBatch`/`applyEditBatch`, the same as every other package
here. `revamp generate` on the CLI drives it end-to-end.

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
  cli/     four commands, together the harness every phase gets tested
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
             - `revamp generate <path>` — runs `@revamp/generator`
               end-to-end: scan, pick a direction, build batches, preview
               (or `--write`) every one. No AI, no network, no MCP server
               needed — the same "provable without an AI in the loop"
               philosophy `revamp scan` established for Phase 0.
  mcp/     an MCP server (`bin/revamp-mcp.js`, stdio) wrapping the exact
           same four operations as four tools: `scan_project`,
           `list_addresses`, `validate_batch`, `apply_batch` (the last
           two share one zod schema — `AbsoluteEditBatchSchema` — rather
           than redefining the batch shape a third time). No new logic of
           its own; every handler is a thin, directly-tested wrapper
           around `@revamp/ast`/`@revamp/core`. Every path argument must
           be absolute — unlike the CLI, which resolves a relative one
           against a human's visible CWD, an MCP server's own working
           directory isn't something the calling host agent can see.
           `apply_batch`'s `write` defaults to `false`, the same
           default-safe posture as the CLI's `--write` flag.
  generator/ the deterministic design-direction generator (Phase 4) — no AI,
           fully unit-tested. `pickDirection(scan)` matches the product
           brief against a small set of signal words and picks one of
           three named presets (`operational`/`consumer`/`calm`); for
           every static `className` and every `cva()` call it finds,
           `remapClassName` re-hues color utilities (same prefix, same
           shade number — preserving whatever contrast decision was
           already made, just changing the hue family) and normalizes
           non-`rounded-full` radius utilities to the preset's one
           canonical value. Never touches a dynamic className
           (`cn(...)`, same refuse-to-guess rule as the validator), a
           layout/spacing utility, or a variant-prefixed one
           (`hover:`/`focus:`/`dark:` — a documented v1 gap, not an
           oversight). Emits ordinary `EditBatch` values — nothing
           bypasses validation; `generate.test.ts` proves every batch it
           produces against the real `validateEditBatch`/`applyEditBatch`,
           not just its own bookkeeping. `revamp generate <path>` on the
           CLI drives it end-to-end (dry-run diff by default, `--write`
           to commit, same posture as `revamp apply`).
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
.claude/skills/
  revamp/  the skill pack: `SKILL.md` (manual-invoke only — `/revamp`,
           deliberately not auto-triggered — walks through deciding a
           design direction, then discovering addresses, previewing, and
           landing edits via the four MCP tools above, one file at a
           time) + `reference-design-direction.md` (how to pick a
           palette/type-scale/spacing rhythm that's expressible entirely
           in Tailwind utilities + existing theme tokens — none of the
           five ops can touch the theme file itself). No new logic to
           test; every tool it calls already has its own test coverage.
```

## Try it

```
npm install
npm run build
node packages/cli/dist/bin/revamp.js scan ./fixtures/fleet-dashboard
node packages/cli/dist/bin/revamp.js addresses ./fixtures/fleet-dashboard/src/routes/FleetDashboard.tsx FleetDashboard
node packages/cli/dist/bin/revamp.js apply my-batch.json       # dry-run diff
node packages/cli/dist/bin/revamp.js apply my-batch.json --write
node packages/cli/dist/bin/revamp.js generate ./fixtures/fleet-dashboard          # no AI, dry-run diff
node packages/cli/dist/bin/revamp.js generate ./fixtures/fleet-dashboard --write
```

To run the MCP server directly (reads/writes JSON-RPC over stdio — not
meant to be typed at by a human, shown here just to confirm it starts):

```
node packages/mcp/dist/bin/revamp-mcp.js
```

This repo's root `.mcp.json` already registers it for Claude Code, using
`${CLAUDE_PROJECT_DIR:-.}` so the same config works regardless of where the
repo is cloned:

```json
{
  "mcpServers": {
    "revamp-engine": {
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/packages/mcp/dist/bin/revamp-mcp.js"]
    }
  }
}
```

In an interactive session, Claude Code shows a one-time workspace-trust
prompt before a checked-in `.mcp.json`'s servers actually start — until
that's accepted, `revamp-engine`'s tools (and the `/revamp` skill below,
which depends on them) won't be available. Once trusted, this loads
automatically on every session in this repo.

With that configured and the project built, the skill pack
(`.claude/skills/revamp/`) is available as `/revamp` — manual-invoke only,
on purpose (see `docs/phase-3-skill-pack.md`). It drives the same four
tools end-to-end: decide a design direction, then discover addresses,
preview, and land edits one file at a time, never touching a file any
other way.

Run the safety tests — these ARE the Phase 0-4 stop-and-checks from the
build plan, not a separate afterthought:

```
cd packages/ast && npx vitest run
cd packages/core && npx vitest run
cd packages/generator && npx vitest run
cd packages/mcp && npx vitest run
```

126 tests across ten files (83 in `@revamp/ast`, 5 in `@revamp/core`,
27 in `@revamp/generator`, 11 in `@revamp/mcp`), and each one is a
specific claim, not a vague "it works":

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

**`@revamp/mcp`'s `server.test.ts` (11 tests) — the one genuinely new
kind of surface in this project, verified by actually connecting a real
MCP `Client` to the real server over `InMemoryTransport`, not by asserting
on the handler functions directly:**
- `tools/list` exposes exactly the four tools this phase set out to wrap
- `scan_project` scans the real fixture correctly, and is rejected — as a
  normal `isError` result, not a broken connection — for a relative
  `projectPath`
- `list_addresses` finds an `h1` in `FleetDashboard` and the JSX root
  inside the forwardRef-wrapped `Button`
- `validate_batch` accepts a legal batch, rejects one whose address
  doesn't resolve, and is rejected at the schema boundary (before
  `validateEditBatch` ever runs) for a relative file path
- `apply_batch` against a throwaway copy of the fixture (never the
  tracked file itself): a dry run returns a diff and leaves the file on
  disk untouched (read back and compared byte-for-byte), `write: true`
  actually writes it, and a rejected batch writes nothing regardless of
  `write`

**`@revamp/generator` (27 tests across three files) — the deterministic
design-direction generator:**
- `direction.test.ts` (5 tests): the operational/consumer/calm presets are
  picked by matching the product brief against signal words, the fallback
  is a genuine third option rather than a reused default, picking is
  deterministic (same brief, same preset, always), and operational signals
  are checked — and win — before consumer ones when a brief could
  arguably match both
- `tailwindTokens.test.ts` (12 tests): a neutral/accent/danger-family color
  utility re-hues to the right direction family at the *same* prefix and
  shade (preserving whatever contrast decision was already made); a token
  already matching the direction is left alone (never a same-value
  "replacement"); every non-`rounded-full` radius utility normalizes to
  the direction's one canonical value, `rounded-full` itself never does;
  layout/spacing utilities, arbitrary values, and variant-prefixed
  utilities (`hover:`/`focus:`/`dark:` — confirmed against the real
  fixture's own `hover:bg-slate-800`) are all left untouched, on purpose
- `generate.test.ts` (10 tests) — the test that actually matters: **every
  batch generated against both real fixtures is fed through the real
  `validateEditBatch` and `applyEditBatch`**, not asserted correct by
  reading the generator's own code. Specific, hand-verified cases: Badge's
  accent/danger variants re-hue but its already-slate `idle` variant
  doesn't move; Button's base radius normalizes while its
  already-slate/variant-prefixed utilities don't; `card.tsx` gets no
  batch at all (everything in it already matches); the single-argument
  `cva({...})` form (`IconButton`) is handled with no `base` field;
  `input.tsx` gets no batch either, because its own className is
  `cn(...)` — exactly as dynamic as every shadcn primitive's own root
  element, correctly left alone

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

## What Phases 2 through 4 built (see the build-order doc)

Phase 0 through Phase 4 are all done: scan → hash → address → validate →
apply, reachable from a terminal (`revamp`), from a host agent
(`@revamp/mcp`), driven end-to-end by an LLM (`/revamp`), or driven
end-to-end with no AI at all (`revamp generate`) — with two fixtures
exercised at every layer. What Phase 2 built, in the order it was built:

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
- ~~the MCP server~~ **done** (`@revamp/mcp`, `bin/revamp-mcp.js`, stdio):
  four tools — `scan_project`, `list_addresses`, `validate_batch`,
  `apply_batch` — each one a thin wrapper that reads a file and calls
  straight into `@revamp/ast`/`@revamp/core`; no new logic of its own.
  Every path argument must be absolute (`AbsolutePathSchema`,
  `AbsoluteEditBatchSchema`) — an MCP server's own working directory
  isn't something the calling host agent can see or control, unlike a
  human running the CLI from a known directory, so there's no safe
  default to resolve a relative one against. `apply_batch`'s `write`
  defaults to `false`, same posture as the CLI's `--write`. Verified by
  connecting a real `Client` to the real server over `InMemoryTransport`
  (11 tests — see above) and by a raw stdio JSON-RPC smoke test against
  the actual compiled binary, not just the in-memory harness. Full
  design writeup — the MCP SDK API decisions, why `registerTool`'s own
  schema validation was relied on rather than re-validating by hand, the
  `isError`-result-not-a-thrown-exception lesson — in
  docs/phase-2-fixtures-apply-and-mcp.md.

Phase 3 — the skill pack (`.claude/skills/revamp/`) — **done**:

- `SKILL.md`, manual-invoke only (`disable-model-invocation: true` —
  deliberately not auto-triggered by an ambiguous "make this look better";
  see docs/phase-3-skill-pack.md for the asymmetry-of-cost reasoning).
  Walks through deciding a design direction from the scan's product brief,
  then per file: `list_addresses` → build one batch → `validate_batch` →
  `apply_batch` dry-run → show the diff and get confirmation →
  `apply_batch` with `write: true`. Never edits a file any other way.
- `reference-design-direction.md` — a concrete heuristic for choosing a
  palette/type-scale/spacing rhythm, grounded in the one real tooling
  boundary that shapes it: **no edit op can touch the Tailwind theme
  file**, so a direction has to be expressible entirely in Tailwind's
  built-in utilities, arbitrary values, or existing theme tokens.
- A root `.mcp.json` (`${CLAUDE_PROJECT_DIR:-.}`-relative, portable
  regardless of where the repo is cloned) registering `revamp-engine` for
  Claude Code, so the skill pack is self-contained — clone, `npm install
  && npm run build`, accept the one-time workspace-trust prompt, and
  `/revamp` works.
- Chosen deliberately over a second, deterministic design-system-generator
  package: a rule-based generator would be unit-testable the way every
  other package here is, but "distinctive, coherent, accessible" for a
  *specific* codebase's specific product is a contextual judgment call,
  not a formula — see docs/phase-3-skill-pack.md for the full tradeoff,
  named honestly rather than hidden (this phase's correctness isn't
  verifiable by a test suite the way Phases 0-2's was).

Phase 4 — the deterministic generator (`@revamp/generator`) — **done**,
built as the AI-driven skill's sibling rather than its replacement, exactly
the option Phase 3 left open: picks one of three named presets
(`pickDirection`, matched against the product brief's own signal words,
deterministic — same brief, same preset, always), then mechanically
re-hues every color utility it finds (same prefix, same shade number —
preserving whatever contrast decision was already made) and normalizes
radius values, across both `className`s and `cva()` calls. Unlike Phase 3,
this phase's correctness IS verifiable by a test suite — 27 tests, the
most important of which feed every batch generated against both real
fixtures through the real `validateEditBatch`/`applyEditBatch` rather than
trusting the generator's own bookkeeping. `revamp generate` on the CLI
proves it end-to-end the same way `revamp apply` proved the applier.
Full design writeup (why three presets and not an open palette space, the
same-prefix-same-shade re-hueing trick, the variant-prefix limitation
found by testing against the real fixture, not planned for) in
docs/phase-4-generator.md.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`/`master`: a
clean `npm ci`, a full `npm run build` (workspace packages consume each
other's *built* `dist/` output via their own `package.json` `main` field,
not raw source — build has to run before test, not just before publish),
the complete `npm test` across all four packages, then a smoke test of
`revamp scan`/`revamp generate` against both fixtures — the two CLI
commands that exercise meaningfully without a JSON batch file or a
running MCP client. The exact sequence was run by hand first (including a
from-scratch `npm ci` against the committed lockfile) to confirm it works
before being written into the workflow, not assumed from the YAML syntax
alone. No separate phase doc for this one — it's a small, mechanical
addition (wire up commands already proven; no new judgment calls), not a
phase-sized decision the way 0 through 4 were.

Nothing further is currently planned beyond this. The original 9-phase
build order's remaining phases were never read by whoever has been
building this (see the top of this README) — if there's more to build,
it isn't reflected here yet.
