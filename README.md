# revamp-ai

**Let an AI restyle your React UI — without letting it touch your logic.**

`revamp` is a CLI, MCP server, and Claude Code skill pack that re-themes a
React + Tailwind + shadcn/ui codebase (colors, spacing, shape, visual
direction) under a hard, machine-verified guarantee: **no edit it makes can
change what your application does.** Every change is proven safe before it's
written, not just reviewed by eye.

[![CI](https://github.com/1-apex/revamp-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/1-apex/revamp-ai/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## The problem

Ask an AI coding agent to "make this page look better" and it usually *can*
— but you're now reviewing a diff that might also have quietly rewired an
`onClick`, dropped a conditional, or reordered a hook. There's no cheap way
to tell "this diff is purely cosmetic" from "this diff also changed behavior"
just by reading it.

## How revamp solves it

Every file revamp touches is reduced to a **logic-skeleton hash**: parse the
file, strip everything presentational (`className`, `style`, `cva` variant
class strings), hash what's left — hooks, handlers, props, conditionals,
data flow, component identity. Two versions of a file with the same hash are
*the same logic wearing different clothes*.

On top of that, revamp only allows edits expressed as one of **five
whitelisted, schema-validated operations** — there is no general "edit this
file" tool:

| Op | What it can do |
|---|---|
| `set_class_list` | Rewrite a plain-string `className` |
| `set_cva_variants` | Rewrite an existing `cva()` variant's class string |
| `wrap_element` | Wrap a node in a new decorative element (no new props/handlers possible — the schema has no field for them) |
| `insert_presentational` | Insert a new decorative, childless element at a position |
| `add_import` | Add an import from an explicit source allowlist |

Before anything is written, every op is **validated** against the live file
(does the address still resolve? is the target actually a plain string, not
a dynamic expression like `cn(...)`? would this collide with another op in
the batch?) and then **gated** after being applied:

- Pure styling ops must leave the logic-skeleton hash **byte-for-byte
  unchanged**.
- The one structural op a batch is allowed must preserve every original
  token **in order**, adding only the exact new tokens its schema allows.

**Any failure reverts the entire batch.** There is no partial edit.

## Three ways to drive it

- **`/revamp`** — an AI-driven Claude Code skill. Point it at your project;
  it picks a design direction from your product's own signals, then walks
  every file end-to-end (discover edit addresses → build a batch → validate
  → preview the diff → apply), one file at a time, never editing any other
  way.
- **`revamp generate`** — a fully deterministic alternative with **no AI
  involved at all**: picks one of three named presets and mechanically
  re-hues colors / normalizes border radius across your project.
- **Direct CLI or MCP tool calls** — script it yourself, or wire it into
  your own host agent.

## What's inside

```
packages/
  core/       Stack detection (React/Tailwind v4/shadcn), component & route
              scanning, JSX role classification. Read-only — never writes.
  ast/        The safety layer: logic-skeleton hashing, stable node
              addressing + fingerprinting, the 5-op schema, the validator,
              and the ts-morph-based applier that actually lands an edit.
  generator/  The deterministic, no-AI design-direction generator.
  mcp/        An MCP server exposing scan/list-addresses/validate/apply as
              four tools over stdio, for any host agent to call directly.
  cli/        `revamp` — scan, addresses, apply, generate. The harness every
              other package is tested against.
.claude/skills/revamp/
              The /revamp skill pack for Claude Code, driving the MCP
              server end-to-end.
fixtures/
              Two hand-authored React + Tailwind v4 + shadcn-style sample
              apps, exercised by the full test suite.
```

## Installation

```bash
git clone https://github.com/1-apex/revamp-ai.git
cd revamp-ai
npm install
npm run build
```

Requires Node 20+.

## Quick start

**CLI:**

```bash
# See what revamp detects about a project
node packages/cli/dist/bin/revamp.js scan ./fixtures/fleet-dashboard

# List every addressable JSX node in a component
node packages/cli/dist/bin/revamp.js addresses ./fixtures/fleet-dashboard/src/routes/FleetDashboard.tsx FleetDashboard

# No-AI deterministic restyle — dry-run diff by default
node packages/cli/dist/bin/revamp.js generate ./fixtures/fleet-dashboard
node packages/cli/dist/bin/revamp.js generate ./fixtures/fleet-dashboard --write

# Apply a hand-written edit batch ({ file, ops })
node packages/cli/dist/bin/revamp.js apply my-batch.json
node packages/cli/dist/bin/revamp.js apply my-batch.json --write
```

**As a Claude Code skill:** this repo's `.mcp.json` registers the MCP server
automatically. After `npm install && npm run build`, open the repo in Claude
Code, accept the one-time workspace-trust prompt, and run `/revamp`.

**As a standalone MCP server** (stdio JSON-RPC, for any host agent):

```bash
node packages/mcp/dist/bin/revamp-mcp.js
```

## Design guarantees (by construction, not convention)

- At most **one** structural op (`wrap_element` / `insert_presentational`)
  per batch — closes the whole class of address-collision bugs a second
  structural op in the same batch could otherwise cause.
- `set_class_list` / `set_cva_variants` only ever rewrite a **plain string
  literal**. A dynamic className (`cn(...)`, a ternary, a template literal)
  is left untouched — revamp never guesses what a safe rewrite would mean.
- No edit op can read or write the Tailwind **theme file** itself — every
  design direction has to be expressible in Tailwind's own utilities and
  existing tokens.
- JSX produced inside a `.map()` call or a ternary's branches isn't
  addressable yet — a documented v1 scope cut, not a silent gap.

## Testing

```bash
cd packages/ast && npx vitest run
cd packages/core && npx vitest run
cd packages/generator && npx vitest run
cd packages/mcp && npx vitest run
```

126 tests across the four packages — including, for the generator, feeding
every batch it produces through the real validator and applier rather than
trusting its own bookkeeping, and for the MCP server, connecting a real
client to the real server over an in-memory transport rather than asserting
on handler functions directly.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: a clean install,
a full build, the complete test suite, then a smoke test of `revamp scan`
and `revamp generate` against both fixtures.

## Status

Scan → hash → address → validate → apply is complete and tested end-to-end,
reachable from a terminal, from any MCP-speaking host agent, driven by an
LLM via `/revamp`, or driven with no AI at all via `revamp generate`.

## Contributing

Issues and PRs are welcome. Please include tests for any behavioral change
— especially anything touching the logic-skeleton hash, addressing, or the
validator/applier gates, since those are this project's actual safety
contract.

## License

[MIT](./LICENSE)
