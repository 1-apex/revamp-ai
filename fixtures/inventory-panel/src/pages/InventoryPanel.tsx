import * as React from "react";
import { Input } from "../components/ui/input";
import { IconButton } from "../components/ui/icon-button";

interface Item {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  reorderThreshold: number;
}

async function fetchItems(): Promise<Item[]> {
  const res = await fetch("/api/inventory");
  if (!res.ok) throw new Error("failed to load inventory");
  return res.json();
}

// A custom hook, defined in the same file as the component that uses it —
// `useInventory` starts lowercase so the scanner's "component name starts
// with a capital letter" rule must not mistake it for one, and its own
// useState/useEffect calls must still show up as hooks on *this* function,
// not get attributed to InventoryPanel just because they're in the same file.
function useInventory(query: string) {
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchItems()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = React.useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.sku.toLowerCase().includes(q) || item.name.toLowerCase().includes(q));
  }, [items, query]);

  return { loading, items: filtered };
}

// Named export, not default — fleet-dashboard's FleetDashboard is a
// default export, so this is the first fixture coverage of the other
// common shape. Lives under pages/ rather than routes/ to exercise the
// scanner's alternate route-path pattern.
export function InventoryPanel() {
  const [query, setQuery] = React.useState("");
  const { loading, items } = useInventory(query);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU or name…" />
        <IconButton tone="neutral" aria-label="Refresh" onClick={() => setQuery((q) => q)}>
          ↻
        </IconButton>
      </div>

      {
        // JSX nested inside a ternary branch, not an early `return` — the
        // same addressing limitation as JSX inside a .map() callback
        // (documented in addressing.ts), now exercised here: neither
        // branch below is reachable through a positional path from this
        // component's single root, since both live inside a non-JSX
        // ConditionalExpression the walk doesn't descend into.
        loading ? (
          <span className="text-sm text-neutral-500">Loading inventory…</span>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2">
                <span>
                  {item.name} ({item.sku})
                </span>
                {item.quantity <= item.reorderThreshold ? (
                  <IconButton tone="danger" aria-label="Flag for reorder">
                    !
                  </IconButton>
                ) : (
                  <span className="text-sm text-neutral-500">{item.quantity} in stock</span>
                )}
              </li>
            ))}
          </ul>
        )
      }
    </div>
  );
}
