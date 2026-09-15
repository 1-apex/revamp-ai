# Revamp Engine

An MCP server and skill pack that gives a React codebase a distinctive,
coherent, accessible UI — under a hard guarantee that not one line of
application logic changes.

Full spec and 9-phase build order (design docs, not code) were written
before this repo existed; this repo is Phase 0 of that plan, actually
built and tested, not just described.

**Status: Phase 0 only.** There is no editing, no MCP server, and no design
system generator yet. What exists is the safety instrument everything else
gets built on: a way to scan a React project and prove, with a hash, that a
later change did or didn't touch its logic.

## What's here

```
packages/
  ast/     the logic-skeleton hash — parses a file, strips everything
           presentational (className, style, cva's class strings), hashes
           what's left (hooks, handlers, props, conditionals, data flow,
           component identity). Two files with the same hash are "the same
           code wearing different clothes."
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
                     real conditional rendering) to scan and hash against.
                     More fixtures — ideally real open-source repos — are
                     the first thing to add before Phase 1.
```

## Try it

```
npm install
npm run build
node packages/cli/dist/bin/revamp.js scan ./fixtures/fleet-dashboard
```

Run the safety tests — these ARE the Phase 0 stop-and-check from the build
plan, not a separate afterthought:

```
cd packages/ast && npx vitest run
```

Eight tests, and each one is a specific claim about the hash:

- Prettier reformatting (default config, and a very different one —
  narrow width, no semicolons, single quotes) never moves the hash
- an edit to `className` alone never moves the hash
- rewiring a button's `onClick` to a different handler always moves it
- changing a `useEffect` dependency array always moves it
- reordering two independent `useState` calls always moves it
- the hash is deterministic (same input, same output, always)

If any of the "never moves" tests goes red, the fix is in the hash, never
in the test. If a "always moves" test goes red, something in the logic
skeleton stopped being sensitive to a real bug class, which is worse.

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

## Environment note

Installing packages from inside the sandboxed dev VM this session used
(`device_bash`) required `npm config set strict-ssl false`, because that
VM's outbound traffic goes through a local MITM proxy for its own traffic
inspection and npm's proxy-agent doesn't pick up the proxy's CA the way
curl does. That's specific to this sandbox — installing in a normal
terminal on this machine should not need it.

## Next (Phase 1 — see the build-order doc)

The edit-op safety layer: node addressing with fingerprints, the ten
allowed operations, the validator, the `ts-morph` applier, and
`tailwind-merge` normalization. That's the layer that turns "we can prove
nothing changed" into "we can safely change something."

A known, documented limitation to pick up there: the logic-skeleton hash
does not yet prune purely decorative wrapper elements (e.g. a bare `<div>`
added only to hold a class), so a future `wrap_element` operation will
currently register as a hash change. The applier should special-case that
rather than the hash trying to guess "decorative" in general.
