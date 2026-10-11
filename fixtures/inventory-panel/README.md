# Inventory Panel

A warehouse inventory tool. Search SKUs, see live stock counts, flag
anything running low for reorder. Second fixture, deliberately shaped to
hit scanner/addressing patterns the first one (`fleet-dashboard`) doesn't:
a `React.memo(React.forwardRef(...))` double-wrapped primitive, a
single-argument `cva({...})` call (no base class string), a named
(non-default) export page component under `pages/` instead of `routes/`,
and a ternary branch inside the JSX tree itself (`{loading ? <A/> : <B/>}`)
rather than only an early `return` — see
`docs/phase-2-fixtures-apply-and-mcp.md` for why each of these was picked.
