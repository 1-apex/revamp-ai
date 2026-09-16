# Revamp Engine

An MCP server and skill pack that gives a React codebase a distinctive,
coherent, accessible UI — under a hard guarantee that not one line of
application logic changes.

Full spec and 9-phase build order (design docs, not code) were written
before this repo existed; this repo is Phase 0 (done) and the start of
Phase 1 of that plan, actually built and tested, not just described.

**Status: Phase 0 complete, Phase 1 in progress.** Phase 0 is the safety
instrument everything else gets built on: a way to scan a React project
and prove, with a hash, that a later change did or didn't touch its logic.
Phase 1 is the edit-op safety layer built on top of it — node addressing
is done and tested; the edit-op schema, validator, applier, and adversarial
test suite are next. There is still no MCP server and no design system
generator yet.

## What's here

```
packages/
  ast/     the safety layer.
             - logic-skeleton hash: parses a file, strips everything
               presentational (className, style, cva's class strings),
               hashes what's left (hooks, handlers, props, conditionals,
               data flow, component identity). Two files with the same
               hash are "the same code wearing different clothes."
             - node addressing: gives every JSX element in a component a
               stable address (file :: component :: which return-JSX ::
               positional path) and a fingerprint (tag + non-presentational
               attribute names + shallow child shape). `resolveAddress`
               re-locates an address against the CURRENT state of a file
               and recomputes its fingerprint — this is what every future
               edit-op will call before touching anything, and it aborts
               rather than guesses the moment the file has structurally
               changed underneath it.
  core/    the scanner — detects the stack (React version, Tailwind v4,
           shadcn/ui), finds every component and route, classifies JSX
           elements by role, and infers a product brief from
           package.json / README / route names. Never writes anything.
  cli/     `revamp scan <path>` — prints what core+ast find. Also the
           harness every later phase gets tested against without needing
           an AI in the loop.
fixtures/
  fleet-dashboard/   one hand-authored React + Tailwind v4 + shadcn-style
                     fixture (a dashboard with real hooks, real handlers,
                     real conditional rendering, three JSX-yielding return
                     branches, and a `.map()` callback) to scan, hash, and
                     address against. More fixtures — ideally real
                     open-source repos — are worth adding before the
                     validator/applier lean on this one alone.
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
```

33 tests across three files, and each one is a specific claim, not a
vague "it works":

**`logicSkeleton.test.ts` (8 tests) — the hash:**
- Prettier reformatting (default config, and a very different one —
  narrow width, no semicolons, single quotes) never moves the hash
- an edit to `className` alone never moves the hash
- rewiring a button's `onClick` to a different handler always moves it
- changing a `useEffect` dependency array always moves it
- reordering two independent `useState` calls always moves it
- the hash is deterministic (same input, same output, always)

**`addressing.test.ts` (9 tests) — node addressing:**
- enumeration finds exactly the three JSX-yielding return points in the
  fixture (the error branch, the loading branch, the main content)
- enumeration never reaches JSX produced inside a `.map()` callback — a
  documented v1 scope cut, proven empirically rather than just asserted
- every enumerated address re-resolves against the same file with a
  matching fingerprint
- a `className`-only edit leaves a resolved address's fingerprint
  unchanged (presentational churn is tolerated)
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
   path in the same project. **Rule for the applier (Phase 1, next):
   never hold a `SourceFile`/`Node` reference across a reload of its own
   path in the same project — re-fetch and re-resolve against the file
   that was just loaded, every time.** This is exactly the discipline
   `resolveAddress` already enforces by design (never reuse an old
   resolution result); the bug was in test code that skipped it, not in
   `addressing.ts` itself, but it's exactly the class of mistake the real
   applier must not make.

## Environment note

Installing packages from inside the sandboxed dev VM this session used
(`device_bash`) required `npm config set strict-ssl false`, because that
VM's outbound traffic goes through a local MITM proxy for its own traffic
inspection and npm's proxy-agent doesn't pick up the proxy's CA the way
curl does. That's specific to this sandbox — installing in a normal
terminal on this machine should not need it.

## Next (Phase 1 — see the build-order doc)

Node addressing is done. What's left to finish the edit-op safety layer:

- ~~the edit-op schema~~ **done** (`packages/ast/src/editOps.ts`): five
  zod-validated op shapes — `set_class_list`, `set_cva_variants`,
  `wrap_element`, `insert_presentational`, `add_import` — plus a
  `parseEditBatch()` entry point. As much "is this even legal" as
  possible is enforced in the schema itself (wrapper/insert tag
  allowlists, a presentational-attribute allowlist with a handler-name
  regex as defense in depth, an import-source allowlist, identifier-shaped
  local names, "an op must actually change something"), not deferred to
  the validator. 16 new tests (49 total in `@revamp/ast`) cover every op
  parsing when valid and every one of those invariants actually rejecting
  a bad payload, not just accepting a good one.
- the validator (fingerprint match via `resolveAddress`, cva variant-key
  immutability, the *diff* check for `wrap_element`/`insert_presentational`
  described in `editOps.ts` — existing tokens unchanged and in order, only
  the specific new decorative tokens each op is allowed to add, never a
  handler or a hook — and same-batch `add_import` collision/shadow checks)
- the `ts-morph` applier + `tailwind-merge` class-string normalizer, with
  the Phase 0 logic-skeleton hash as the final all-or-nothing per-file gate
- an adversarial test suite: one test per validator rule that genuinely
  tries to break it, plus "one illegal op in a batch reverts the whole
  file"
- `revamp apply` on the CLI (dry-run diff by default, `--write` to commit)
  proven end-to-end on the fleet-dashboard fixture

A known, documented limitation carried over from Phase 0: the
logic-skeleton hash does not yet prune purely decorative wrapper elements
(e.g. a bare `<div>` added only to hold a class), so a future
`wrap_element` operation will currently register as a hash change. The
applier should special-case that rather than the hash trying to guess
"decorative" in general.

A known, documented limitation in node addressing itself: an address only
reaches JSX that is a positional descendant of a component's own return
value. JSX produced inside a callback (`.map(v => <Card/>)`, and similar)
is not addressable yet — it still renders, this engine just can't target
it with an edit-op until the addressing scheme grows a notion of "inside
this specific callback." That's Phase 1b work, proven by test to be a
scope cut and not an accidental gap.
