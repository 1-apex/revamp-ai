import { describe, it, expect } from "vitest";
import {
  parseEditBatch,
  EditOpSchema,
  SetClassListOpSchema,
  WrapElementOpSchema,
} from "./editOps.js";

const baseAddress = { file: "a.tsx", component: "Foo", root: 0, path: [0, 1] };

describe("edit-op schema — the five op shapes parse when valid", () => {
  it("set_class_list", () => {
    const op = { op: "set_class_list", address: baseAddress, className: "p-4 text-sm" };
    expect(EditOpSchema.parse(op)).toMatchObject(op);
  });

  it("set_cva_variants", () => {
    const op = {
      op: "set_cva_variants",
      file: "button.tsx",
      varName: "buttonVariants",
      variants: { intent: { primary: "bg-blue-600", secondary: "bg-slate-200" } },
    };
    expect(EditOpSchema.parse(op)).toMatchObject(op);
  });

  it("wrap_element", () => {
    const op = { op: "wrap_element", address: baseAddress, wrapperTag: "div", wrapperClassName: "relative" };
    expect(EditOpSchema.parse(op)).toMatchObject(op);
  });

  it("insert_presentational", () => {
    const op = {
      op: "insert_presentational",
      parentAddress: baseAddress,
      atIndex: 0,
      tag: "hr",
      className: "my-4",
      attributes: { "aria-hidden": "true" },
    };
    expect(EditOpSchema.parse(op)).toMatchObject(op);
  });

  it("add_import", () => {
    const op = { op: "add_import", file: "a.tsx", source: "lucide-react", imported: "ArrowRight", localName: "ArrowRight" };
    expect(EditOpSchema.parse(op)).toMatchObject(op);
  });
});

describe("edit-op schema — rejects what it's supposed to reject", () => {
  it("rejects an op that isn't one of the five known shapes", () => {
    expect(() => EditOpSchema.parse({ op: "delete_file", file: "a.tsx" })).toThrow();
  });

  it("rejects a wrap_element wrapperTag outside the allowlist (e.g. a real element like button)", () => {
    expect(() =>
      WrapElementOpSchema.parse({ op: "wrap_element", address: baseAddress, wrapperTag: "button" })
    ).toThrow();
  });

  it("rejects insert_presentational carrying anything that looks like a handler", () => {
    expect(() =>
      EditOpSchema.parse({
        op: "insert_presentational",
        parentAddress: baseAddress,
        atIndex: 0,
        tag: "div",
        attributes: { onClick: "somehow" },
      })
    ).toThrow();
  });

  it("rejects insert_presentational attributes not on the presentational allowlist", () => {
    expect(() =>
      EditOpSchema.parse({
        op: "insert_presentational",
        parentAddress: baseAddress,
        atIndex: 0,
        tag: "div",
        attributes: { href: "/somewhere" },
      })
    ).toThrow();
  });

  it("rejects add_import from a source not on the allowlist", () => {
    expect(() =>
      EditOpSchema.parse({ op: "add_import", file: "a.tsx", source: "left-pad", imported: "leftPad", localName: "leftPad" })
    ).toThrow();
  });

  it("accepts add_import from a prefix-allowlisted local source", () => {
    const op = { op: "add_import", file: "a.tsx", source: "@/components/ui/tooltip", imported: "Tooltip", localName: "Tooltip" };
    expect(EditOpSchema.parse(op)).toMatchObject(op);
  });

  it("rejects add_import with a localName that isn't a valid identifier", () => {
    expect(() =>
      EditOpSchema.parse({ op: "add_import", file: "a.tsx", source: "lucide-react", imported: "X", localName: "not-an-identifier" })
    ).toThrow();
  });

  it("rejects set_cva_variants that changes nothing (neither base nor variants)", () => {
    expect(() =>
      EditOpSchema.parse({ op: "set_cva_variants", file: "button.tsx", varName: "buttonVariants" })
    ).toThrow();
  });

  it("rejects a negative path index in an address", () => {
    expect(() =>
      SetClassListOpSchema.parse({
        op: "set_class_list",
        address: { ...baseAddress, path: [0, -1] },
        className: "p-4",
      })
    ).toThrow();
  });
});

describe("parseEditBatch", () => {
  it("parses a batch of mixed ops scoped to one file", () => {
    const batch = parseEditBatch({
      file: "a.tsx",
      ops: [
        { op: "set_class_list", address: baseAddress, className: "p-4" },
        { op: "wrap_element", address: baseAddress, wrapperTag: "section" },
      ],
    });
    expect(batch.ops).toHaveLength(2);
  });

  it("rejects an empty batch", () => {
    expect(() => parseEditBatch({ file: "a.tsx", ops: [] })).toThrow();
  });
});
