import path from "node:path";
import { z } from "zod";
import { EditBatchSchema, type EditBatch } from "@revamp/ast";

/**
 * Every path a tool accepts must be absolute. The CLI (`revamp apply`)
 * resolves a relative path against `process.cwd()` because a human typing
 * a command has an unambiguous, visible working directory; an MCP server
 * is a long-running process a host agent connects to, and that agent has
 * no reliable way to know — let alone control — what the server process's
 * CWD happens to be. Silently resolving a relative path against the
 * wrong base directory is exactly the kind of mistake this project's
 * "refuse to guess" stance (`resolveAddress`, the validator's
 * string-literal-only checks) exists to avoid elsewhere; the same stance
 * applies here, at the boundary where a host agent's request becomes a
 * real filesystem path.
 */
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((p) => path.isAbsolute(p), (p) => ({
    message: `"${p}" is not an absolute path — an MCP server's own working directory isn't something the calling host agent can see or rely on, so every path argument must be absolute`,
  }));

/** Every file-bearing field in a batch, labeled for error messages —
 * mirrors `revamp apply`'s own `resolveBatchPaths` in which fields it
 * walks, but checks instead of rewrites (see `AbsoluteEditBatchSchema`). */
function allFileFields(batch: EditBatch): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [{ label: "file", value: batch.file }];
  batch.ops.forEach((op, i) => {
    switch (op.op) {
      case "set_class_list":
      case "wrap_element":
        fields.push({ label: `ops[${i}].address.file`, value: op.address.file });
        break;
      case "insert_presentational":
        fields.push({ label: `ops[${i}].parentAddress.file`, value: op.parentAddress.file });
        break;
      case "set_cva_variants":
      case "add_import":
        fields.push({ label: `ops[${i}].file`, value: op.file });
        break;
    }
  });
  return fields;
}

/**
 * `EditBatchSchema` itself (shared with the CLI and every `@revamp/ast`
 * test) deliberately doesn't require absolute paths — the CLI wants to
 * accept relative ones from a human. This wraps it with the additional,
 * MCP-surface-specific policy above, enforced the same way the SDK
 * enforces everything else about a tool's input: declaratively, via the
 * schema, before the handler ever runs.
 */
export const AbsoluteEditBatchSchema = EditBatchSchema.superRefine((batch, ctx) => {
  for (const { label, value } of allFileFields(batch)) {
    if (!path.isAbsolute(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [label],
        message: `"${value}" is not an absolute path — every file reference in a batch must be absolute on this surface`,
      });
    }
  }
});
