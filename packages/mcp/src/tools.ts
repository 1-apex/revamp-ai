import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { createPatch } from "diff";
import { scanProject } from "@revamp/core";
import {
  createInMemoryProject,
  loadSourceFile,
  enumerateAddressableNodes,
  addressKey,
  validateEditBatch,
  applyEditBatch,
  type EditBatch,
} from "@revamp/ast";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbsolutePathSchema, AbsoluteEditBatchSchema } from "./paths.js";

/**
 * Four tools, one per layer this project already proved correct on its
 * own: `scanProject` (Phase 0), `enumerateAddressableNodes` (Phase 1
 * addressing), `validateEditBatch` and `applyEditBatch` (Phase 1's
 * validator and applier). This module adds no new logic of its own —
 * every tool is a thin wrapper that reads a file, calls straight into
 * `@revamp/ast`/`@revamp/core`, and shapes the result as MCP content. The
 * one thing genuinely new here, not already proven by an existing test,
 * is wiring — which is exactly what `server.test.ts` exists to check,
 * the same reasoning `revamp apply` used for choosing what to verify by
 * hand (see docs/phase-2-fixtures-apply-and-mcp.md).
 */

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Every handler catches its own errors and returns `isError: true`
 * rather than throwing — an uncaught exception here would be a protocol-
 * level failure (a broken connection to the host agent), not a clean,
 * recoverable tool-call error the agent can read and act on. */
function safeTool<Args>(fn: (args: Args) => CallToolResult): (args: Args) => CallToolResult {
  return (args) => {
    try {
      return fn(args);
    } catch (err) {
      return errorText(`Unexpected error: ${(err as Error).message}`);
    }
  };
}

export const scanProjectTool = {
  name: "scan_project",
  config: {
    title: "Scan project",
    description:
      "Detect the stack (React version, Tailwind, shadcn/ui), find every component and route, and fingerprint " +
      "every file's logic-skeleton hash. Read-only — never writes anything. This is Phase 0's scanner.",
    inputSchema: { projectPath: AbsolutePathSchema },
  },
  handler: safeTool<{ projectPath: string }>(({ projectPath }) => text(scanProject(projectPath))),
};

export const listAddressesTool = {
  name: "list_addresses",
  config: {
    title: "List addressable JSX nodes",
    description:
      "List every addressable JSX node in one component: its {root, path} address and fingerprint. This is the " +
      "only way to discover the address values an edit batch's `address`/`parentAddress` fields need — there is " +
      "no other way to construct a valid one. Read-only.",
    inputSchema: { file: AbsolutePathSchema, component: z.string().min(1) },
  },
  handler: safeTool<{ file: string; component: string }>(({ file, component }) => {
    const source = readFileSync(file, "utf8");
    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, file, source);
    const nodes = enumerateAddressableNodes(sourceFile, component);
    return text(nodes.map((n) => ({ addressKey: addressKey(n.address), address: n.address, fingerprint: n.fingerprint })));
  }),
};

export const validateBatchTool = {
  name: "validate_batch",
  config: {
    title: "Validate an edit batch",
    description:
      "Check whether an edit batch is legal against the real file it targets, without changing anything — every " +
      "address still resolves, every className/cva value is a plain string literal, at most one structure-" +
      "extending op, no op addresses another op's own blast radius. Call this before apply_batch to get fast " +
      "feedback; apply_batch runs the same check internally regardless, so this never has to be called first.",
    inputSchema: { batch: AbsoluteEditBatchSchema },
  },
  handler: safeTool<{ batch: EditBatch }>(({ batch }) => {
    const source = readFileSync(batch.file, "utf8");
    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, batch.file, source);
    const result = validateEditBatch(sourceFile, batch);
    return result.ok ? text(result) : { ...text(result), isError: true };
  }),
};

export const applyBatchTool = {
  name: "apply_batch",
  config: {
    title: "Apply an edit batch",
    description:
      "Validate and apply an edit batch to the file it targets. Returns a unified diff either way. " +
      "`write` defaults to false — nothing is written to disk unless it is explicitly set to true, the same " +
      "default-safe posture as `revamp apply` without --write on the CLI. Call validate_batch first if you only " +
      "want to check legality without a diff.",
    inputSchema: { batch: AbsoluteEditBatchSchema, write: z.boolean().optional() },
  },
  handler: safeTool<{ batch: EditBatch; write?: boolean }>(({ batch, write }) => {
    const originalSource = readFileSync(batch.file, "utf8");
    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, batch.file, originalSource);
    const result = applyEditBatch(sourceFile, batch.file, batch);

    if (!result.ok) return { ...text({ ok: false, errors: result.errors }), isError: true };

    if (result.code === originalSource) {
      return text({ ok: true, written: false, diff: null, note: "batch's result is identical to the current file — nothing to do" });
    }

    const diff = createPatch(batch.file, originalSource, result.code, "before", write ? "after (written)" : "after (dry run)");

    if (write) {
      writeFileSync(batch.file, result.code);
      return text({ ok: true, written: true, diff });
    }
    return text({ ok: true, written: false, diff, code: result.code });
  }),
};

export const ALL_TOOLS = [scanProjectTool, listAddressesTool, validateBatchTool, applyBatchTool] as const;
