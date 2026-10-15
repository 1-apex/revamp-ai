---
name: revamp
description: >-
  Give a React codebase a distinctive, coherent, accessible UI by driving the
  revamp-engine MCP server (scan_project, list_addresses, validate_batch,
  apply_batch) end-to-end — under a hard guarantee that not one line of
  application logic changes. Use when the user asks to restyle, redesign,
  reskin, "give this a new look", improve the visual design, or make a React
  app's UI more distinctive/accessible/modern, in a project where the
  revamp-engine MCP server is configured.
disable-model-invocation: true
---

# Revamp: restyle a React app without touching its logic

This skill drives the `revamp-engine` MCP server through a full restyle: scan
the project, decide a coherent design direction, then change only
presentation — `className`, `cva()` variant class strings, and purely
decorative wrapper/leaf elements — one file at a time, through the server's
`apply_batch` tool. It never edits a file directly. Every change goes through
`apply_batch`, which re-derives the file's logic-skeleton hash (or, for a
structural op, a narrower token-level guarantee) and refuses to land anything
that moves it. If a batch is rejected, that is the safety net working, not an
error to work around by editing the file some other way.

**Manual invocation only** (`disable-model-invocation: true` above): this
skill changes real files across a codebase, so it only runs when the user
explicitly asks for it with `/revamp`, never auto-triggered from an ambiguous
request.

## Prerequisites

1. The `revamp-engine` MCP server must already be configured for this host
   (see the repo's root `README.md`, "Try it" — a `.mcp.json` entry pointing
   at `packages/mcp/dist/bin/revamp-mcp.js`, built with `npm run build`). If
   its tools (`mcp__revamp-engine__scan_project` etc.) aren't available,
   stop and tell the user to configure it first — don't fall back to editing
   files directly; that would defeat the entire point of this project.
2. Every path passed to a tool **must be absolute** — the server has no
   visibility into any notion of "current directory" and rejects a relative
   one outright (see `docs/phase-2-fixtures-apply-and-mcp.md` for why).
   Resolve whatever the user gives you (a relative path, "this project",
   nothing at all — ask or infer from context) to an absolute path yourself
   before the first tool call.

## The five ops, briefly

Full reasoning for each is in `docs/phase-1-edit-safety-layer.md`; this is
just the cheat sheet you need while building a batch.

| op | what it does | targets |
|---|---|---|
| `set_class_list` | replace a JSX element's `className` (merged with the old value via tailwind-merge — pass the full new set of utilities you want present, not a diff) | `address` |
| `set_cva_variants` | rewrite a `cva()` call's `base` and/or specific `variants.<group>.<option>` class strings — never introduces a new group/option | `file` + `varName` |
| `wrap_element` | wrap one JSX node in a new, purely decorative `div`/`span`/`section`/`figure` | `address` |
| `insert_presentational` | insert a new self-closing decorative leaf (`div`/`span`/`hr`/`br`, or an icon component already imported) among a parent's children | `parentAddress` + `atIndex` |
| `add_import` | add one import (from an allowlisted source: `lucide-react`, `@radix-ui/react-icons`, `clsx`, `class-variance-authority`, `@/components/ui/*`, `@/lib/*`) | `file` |

**A batch may contain at most one of `wrap_element`/`insert_presentational`.**
Any number of `set_class_list`/`set_cva_variants`/`add_import` can share a
batch with that one structural op, or with each other. If a file needs more
than one structural change, that's more than one batch, applied in sequence
— list addresses again before building the second one, since the first
batch may have shifted what's at a given path.

## Workflow

### 1. Scan

Call `scan_project` with the absolute project path. Read the stack (Tailwind
version, shadcn presence), the product brief, and the component list. This
tells you what you're working with — don't skip it to save a call; a design
direction chosen without it is a guess, not a decision.

### 2. Decide a design direction

Before touching any file, decide — and briefly state to the user — a
coherent direction: a color palette (with real contrast reasoning, not just
"blue"), a type scale, a spacing rhythm, and how component variants
(`cva()` groups you found in the scan) should map onto it. See
[reference-design-direction.md](reference-design-direction.md) for a
concrete heuristic to use rather than picking values arbitrarily. The goal
from the project's own description is "distinctive, coherent, accessible" —
all three, not just one. A direction that's just "slightly bluer" isn't
distinctive; one with four unrelated accent colors isn't coherent; one with
low-contrast text isn't accessible.

### 3. Per file: discover, build, preview, confirm, land

For each file you're touching:

1. **`list_addresses(file, component)`** — never guess a `{root, path}`.
   There is no other way to get one right; a hand-guessed address either
   gets rejected (the lucky case) or lands on the wrong node.
2. **Build one batch** (`{file, ops: [...]}`) using only the five ops above,
   respecting the one-structural-op-per-batch rule.
3. **`apply_batch(batch, write: false or omitted)`** — always dry-run first,
   even if you're confident. Read the returned `diff`. If `ok: false`, read
   every error in `errors` (there's one per broken op, not just the first) —
   fix the batch or drop that op; do not retry the same batch unchanged.
4. **Show the diff to the user** (or summarize it, for a long batch run) and
   get their go-ahead before writing, the same default-safe posture the CLI
   and the MCP tools themselves already take with `write` defaulting to
   `false`. Don't chain straight from dry-run to `write: true` without that
   checkpoint, even if the user asked for the whole app to be redone — a
   large job is still a sequence of reviewable steps, not one blind action.
5. **`apply_batch(batch, write: true)`** once confirmed.
6. Move to the next file. If a component's JSX is unreachable — `ok` but
   `list_addresses` returns nothing, or a needed node sits inside a
   `.map()`/ternary branch (see `docs/phase-1-edit-safety-layer.md` and
   `docs/phase-2-fixtures-apply-and-mcp.md` for why that's a known, deliberate
   gap, not a bug) — say so plainly and move on rather than attempting a
   workaround outside the five ops.

### 4. Summarize

When done (or when stopping partway through a larger project), tell the user
plainly which files changed, which were skipped and why (unreachable JSX,
a rejected batch, a dynamic className the validator wouldn't touch), and
that the logic-skeleton hash was unchanged for every non-structural edit —
that's the actual guarantee this whole project exists to make, so say it
was kept, not just that "the UI was updated."

## Example batch

Real shape, against the repo's own `fleet-dashboard` fixture — adapt the
`file`/`address` to whatever `list_addresses` returns for your target:

```json
{
  "file": "/abs/path/to/src/routes/FleetDashboard.tsx",
  "ops": [
    {
      "op": "set_class_list",
      "address": {
        "file": "/abs/path/to/src/routes/FleetDashboard.tsx",
        "component": "FleetDashboard",
        "root": 2,
        "path": [0, 0]
      },
      "className": "text-3xl font-semibold tracking-tight"
    }
  ]
}
```

## Non-negotiable rules

- Never write to a file any way other than `apply_batch`. Not `Write`, not
  `Edit`, not a shell command — those bypass every guarantee this project
  makes. If `apply_batch` can't do what you want, the answer is "this edit
  is out of scope for this skill," not "use a different tool."
- Never fabricate an address. Always `list_addresses` first.
- Never retry a rejected batch unchanged. Read the error; it names exactly
  which op and why.
- Dry-run (`write` omitted or `false`) before every `write: true`, no
  exceptions, even in a long batch of many files.
- If `scan_project`/`list_addresses`/`validate_batch`/`apply_batch` aren't
  available as tools, stop and say the MCP server isn't configured — don't
  silently fall back to manual edits.
