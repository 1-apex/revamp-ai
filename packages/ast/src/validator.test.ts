import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInMemoryProject, loadSourceFile, enumerateAddressableNodes } from "./addressing.js";
import { validateEditBatch } from "./validator.js";
import type { EditBatch } from "./editOps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../fixtures/fleet-dashboard/src");
const dashboardPath = path.join(fixtureRoot, "routes/FleetDashboard.tsx");
const dashboardSource = readFileSync(dashboardPath, "utf8");

function projectFor(filePath: string, source: string) {
  const project = createInMemoryProject();
  const sf = loadSourceFile(project, filePath, source);
  return sf;
}

describe("validateEditBatch — set_class_list", () => {
  it("accepts an address that resolves to a real element", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "set_class_list", address: h1.address, className: "text-3xl" }],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an address that no longer resolves", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const badAddress = { ...h1.address, path: [...h1.address.path.slice(0, -1), 99] };
    const batch: EditBatch = { file: dashboardPath, ops: [{ op: "set_class_list", address: badAddress, className: "x" }] };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toMatch(/does not resolve/);
  });

  it("rejects a className op whose address resolves to a Fragment", () => {
    const file = "fragment.tsx";
    const source = `
      export default function Foo() {
        return (
          <>
            <div>hi</div>
          </>
        );
      }
    `;
    const sf = projectFor(file, source);
    const [root] = enumerateAddressableNodes(sf, "Foo");
    expect(root.fingerprint).toMatch(/^element:<>:/);
    // ts-morph's in-memory filesystem normalizes a relative path to an
    // absolute one (leading "/"), which is what ends up on the resolved
    // address — the batch's file must match that, not the string this
    // test happened to pass to loadSourceFile.
    const batch: EditBatch = {
      file: root.address.file,
      ops: [{ op: "set_class_list", address: root.address, className: "x" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/cannot carry a className/);
  });

  it("rejects an op whose address.file doesn't match the batch file", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: "some-other-file.tsx",
      ops: [{ op: "set_class_list", address: h1.address, className: "x" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/does not match batch file/);
  });

  it("rejects a className that's a dynamic expression, not a plain string literal", () => {
    // The real fixture's own Badge: className={cn(badgeVariants({status}), className)}.
    const file = "badge.tsx";
    const source = `
      export function Badge({ className, status, ...props }) {
        return <span className={cn(badgeVariants({ status }), className)} {...props} />;
      }
    `;
    const sf = projectFor(file, source);
    const span = enumerateAddressableNodes(sf, "Badge")[0]!;
    const batch: EditBatch = { file: span.address.file, ops: [{ op: "set_class_list", address: span.address, className: "p-2" }] };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/not a plain string literal/);
  });

  it("accepts a node with no existing className at all", () => {
    const file = "plain.tsx";
    const source = `export default function Foo() { return <div><span>hi</span></div>; }`;
    const sf = projectFor(file, source);
    const span = enumerateAddressableNodes(sf, "Foo").find((n) => n.fingerprint.startsWith("element:span:"))!;
    const batch: EditBatch = { file: span.address.file, ops: [{ op: "set_class_list", address: span.address, className: "p-2" }] };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });
});

describe("validateEditBatch — set_cva_variants", () => {
  const file = "button.tsx";
  const source = `
    import { cva } from "class-variance-authority";
    export const buttonVariants = cva("inline-flex", {
      variants: {
        intent: { primary: "bg-blue-600", secondary: "bg-slate-200" },
        size: { sm: "h-8", lg: "h-12" },
      },
    });
  `;

  it("accepts changing an existing group/option's class string", () => {
    const sf = projectFor(file, source);
    const batch: EditBatch = {
      file,
      ops: [{ op: "set_cva_variants", file, varName: "buttonVariants", variants: { intent: { primary: "bg-indigo-600" } } }],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an unknown varName", () => {
    const sf = projectFor(file, source);
    const batch: EditBatch = {
      file,
      ops: [{ op: "set_cva_variants", file, varName: "nope", base: "x" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/no cva\(\.\.\.\) call/);
  });

  it("rejects introducing a new variant group", () => {
    const sf = projectFor(file, source);
    const batch: EditBatch = {
      file,
      ops: [{ op: "set_cva_variants", file, varName: "buttonVariants", variants: { tone: { loud: "text-xl" } } }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/group "tone" does not exist/);
  });

  it("rejects introducing a new option within an existing group", () => {
    const sf = projectFor(file, source);
    const batch: EditBatch = {
      file,
      ops: [{ op: "set_cva_variants", file, varName: "buttonVariants", variants: { intent: { tertiary: "bg-green-600" } } }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/option "intent.tertiary" does not exist/);
  });

  it("rejects introducing a base string where the call has none (single-argument cva form)", () => {
    const singleArgFile = "single.tsx";
    const singleArgSource = `
      import { cva } from "class-variance-authority";
      export const x = cva({ variants: { intent: { primary: "bg-blue-600" } } });
    `;
    const sf = projectFor(singleArgFile, singleArgSource);
    const batch: EditBatch = {
      file: singleArgFile,
      ops: [{ op: "set_cva_variants", file: singleArgFile, varName: "x", base: "inline-flex" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/has no existing base class-string argument/);
  });

  it("rejects a variant value that isn't a plain string literal", () => {
    const dynFile = "dynamic.tsx";
    const dynSource = `
      import { cva } from "class-variance-authority";
      const extra = "bg-blue-600";
      export const buttonVariants = cva("inline-flex", {
        variants: { intent: { primary: extra } },
      });
    `;
    const sf = projectFor(dynFile, dynSource);
    const batch: EditBatch = {
      file: dynFile,
      ops: [{ op: "set_cva_variants", file: dynFile, varName: "buttonVariants", variants: { intent: { primary: "bg-indigo-600" } } }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/not a plain string literal/);
  });
});

describe("validateEditBatch — wrap_element", () => {
  it("accepts an address that resolves", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "wrap_element", address: h1.address, wrapperTag: "span" }],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });
});

describe("validateEditBatch — insert_presentational", () => {
  it("accepts inserting an allowlisted tag at a valid index", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "insert_presentational", parentAddress: headerRow.address, atIndex: 2, tag: "hr" }],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an out-of-range atIndex", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "insert_presentational", parentAddress: headerRow.address, atIndex: 99, tag: "hr" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/out of range/);
  });

  it("accepts a tag introduced by an add_import op earlier in the same batch", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "add_import", file: dashboardPath, source: "lucide-react", imported: "ArrowRight", localName: "ArrowRight" },
        { op: "insert_presentational", parentAddress: headerRow.address, atIndex: 0, tag: "ArrowRight" },
      ],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a tag that isn't allowlisted, imported this batch, or already imported", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "insert_presentational", parentAddress: headerRow.address, atIndex: 0, tag: "MysteryIcon" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/is not a presentational element/);
  });

  it("accepts a tag that's already imported in the file (from a prior revamp run)", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const headerRow = enumerateAddressableNodes(sf, "FleetDashboard").find(
      (n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0
    )!;
    // Button is already imported at the top of the fixture.
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "insert_presentational", parentAddress: headerRow.address, atIndex: 0, tag: "Button" }],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a self-closing parent — no body to insert into", () => {
    const file = "selfclosing.tsx";
    const source = `export default function Foo() { return <div><img src="/a.png" /></div>; }`;
    const sf = projectFor(file, source);
    const img = enumerateAddressableNodes(sf, "Foo").find((n) => n.fingerprint.startsWith("element:img:"))!;
    const batch: EditBatch = {
      file: img.address.file,
      ops: [{ op: "insert_presentational", parentAddress: img.address, atIndex: 0, tag: "hr" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/self-closing and has no body/);
  });
});

describe("validateEditBatch — batch-level structural constraints", () => {
  it("rejects a batch with more than one structure-extending op", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const nodes = enumerateAddressableNodes(sf, "FleetDashboard");
    const h1 = nodes.find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const headerRow = nodes.find((n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0)!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "wrap_element", address: h1.address, wrapperTag: "span" },
        { op: "insert_presentational", parentAddress: headerRow.address, atIndex: 0, tag: "hr" },
      ],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => e.reason.match(/at most one structure-extending op/))).toBe(true);
  });

  it("rejects set_class_list targeting the exact node a wrap_element in the same batch wraps", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "wrap_element", address: h1.address, wrapperTag: "span" },
        { op: "set_class_list", address: h1.address, className: "text-3xl" },
      ],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason.match(/isn't stable until that op has actually landed/))).toBe(true);
  });

  it("rejects an op addressing a sibling at-or-after an insert_presentational's atIndex in the same batch", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const nodes = enumerateAddressableNodes(sf, "FleetDashboard");
    const headerRow = nodes.find((n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0)!;
    // headerRow's children are [h1, Button] at indices 0 and 1; inserting at
    // index 0 shifts both — the Button at index 1 is exactly the kind of
    // address this should catch.
    const button = nodes.find(
      (n) => n.address.root === 2 && n.address.path.length === 2 && n.address.path[0] === 0 && n.address.path[1] === 1
    )!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "insert_presentational", parentAddress: headerRow.address, atIndex: 0, tag: "hr" },
        { op: "set_class_list", address: button.address, className: "ml-2" },
      ],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason.match(/isn't stable until that op has actually landed/))).toBe(true);
  });

  it("still accepts an insert_presentational alongside an unrelated set_class_list in the same batch", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const nodes = enumerateAddressableNodes(sf, "FleetDashboard");
    const headerRow = nodes.find((n) => n.address.root === 2 && n.address.path.length === 1 && n.address.path[0] === 0)!;
    const h1 = nodes.find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "insert_presentational", parentAddress: headerRow.address, atIndex: 2, tag: "hr" },
        { op: "set_class_list", address: h1.address, className: "text-3xl" },
      ],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });
});

describe("validateEditBatch — add_import", () => {
  it("accepts a fresh localName", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "add_import", file: dashboardPath, source: "lucide-react", imported: "Truck", localName: "Truck" }],
    };
    expect(validateEditBatch(sf, batch)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a localName that collides with an existing import", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [{ op: "add_import", file: dashboardPath, source: "lucide-react", imported: "X", localName: "Button" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/already bound/);
  });

  it("rejects a localName that collides with an existing top-level declaration", () => {
    const file = "utils.tsx";
    const source = `
      export function fetchFleet() { return null; }
      export default function Foo() { return <div/>; }
    `;
    const sf = projectFor(file, source);
    const batch: EditBatch = {
      file,
      ops: [{ op: "add_import", file, source: "lucide-react", imported: "X", localName: "fetchFleet" }],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/already bound/);
  });

  it("rejects two add_import ops in the same batch introducing the same localName", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "add_import", file: dashboardPath, source: "lucide-react", imported: "ArrowRight", localName: "Icon" },
        { op: "add_import", file: dashboardPath, source: "@radix-ui/react-icons", imported: "GearIcon", localName: "Icon" },
      ],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason.match(/more than one add_import op/))).toBe(true);
  });
});

describe("validateEditBatch — collects every error, doesn't stop at the first", () => {
  it("reports one error per broken op in a batch with several", () => {
    const sf = projectFor(dashboardPath, dashboardSource);
    const h1 = enumerateAddressableNodes(sf, "FleetDashboard").find((n) => n.fingerprint.startsWith("element:h1:"))!;
    const batch: EditBatch = {
      file: dashboardPath,
      ops: [
        { op: "set_class_list", address: { ...h1.address, path: [...h1.address.path.slice(0, -1), 99] }, className: "x" },
        { op: "add_import", file: dashboardPath, source: "lucide-react", imported: "X", localName: "Button" },
      ],
    };
    const result = validateEditBatch(sf, batch);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
