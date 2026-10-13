import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../../../fixtures/fleet-dashboard/src");
const dashboardPath = path.join(fixtureRoot, "routes/FleetDashboard.tsx");

/**
 * Every test here connects a real `Client` to a real `McpServer` over
 * `InMemoryTransport` — the actual MCP request/response machinery runs,
 * just without a child process or stdio in the way. This is the thing
 * genuinely new in this step (the other three — scan, addressing,
 * validate/apply — are already proven correct by @revamp/core and
 * @revamp/ast's own test suites); what's being checked here is the
 * wiring: does each tool's declared schema match what the handler
 * expects, does a legal call actually reach @revamp/ast and come back
 * shaped correctly, does an illegal one fail the way a host agent would
 * need it to (loudly, not silently).
 */
async function connectedClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function firstText(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
  return block.text;
}

describe("MCP server — tool list", () => {
  it("exposes exactly the four tools this phase set out to wrap", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["apply_batch", "list_addresses", "scan_project", "validate_batch"].sort()
    );
  });
});

describe("MCP server — scan_project", () => {
  it("scans the real fleet-dashboard fixture", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "scan_project", arguments: { projectPath: path.dirname(fixtureRoot) } });
    expect(result.isError).toBeFalsy();
    const scan = JSON.parse(firstText(result as CallToolResult));
    expect(scan.primitiveCount).toBe(6); // Button included — see the forwardRef fix
    expect(scan.routeCount).toBe(1);
  });

  it("rejects a relative projectPath instead of silently resolving it against the server's own CWD", async () => {
    // Rejected by the SDK's own schema validation before the handler ever
    // runs (AbsolutePathSchema) — surfaced as a normal isError result, not
    // a thrown/rejected call: the SDK never lets a bad-args call look like
    // a broken connection to the calling host agent.
    const client = await connectedClient();
    const result = await client.callTool({ name: "scan_project", arguments: { projectPath: "./fixtures/fleet-dashboard" } });
    expect(result.isError).toBe(true);
    expect(firstText(result as CallToolResult)).toMatch(/not an absolute path/);
  });
});

describe("MCP server — list_addresses", () => {
  it("lists addressable nodes for FleetDashboard, including an h1", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "list_addresses",
      arguments: { file: dashboardPath, component: "FleetDashboard" },
    });
    expect(result.isError).toBeFalsy();
    const nodes = JSON.parse(firstText(result as CallToolResult)) as { fingerprint: string }[];
    expect(nodes.some((n) => n.fingerprint.startsWith("element:h1:"))).toBe(true);
  });

  it("finds a forwardRef-wrapped component too (Button)", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "list_addresses",
      arguments: { file: path.join(fixtureRoot, "components/ui/button.tsx"), component: "Button" },
    });
    const nodes = JSON.parse(firstText(result as CallToolResult)) as { fingerprint: string }[];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]!.fingerprint).toMatch(/^element:button:/);
  });
});

describe("MCP server — validate_batch", () => {
  it("accepts a legal batch without changing anything", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "validate_batch",
      arguments: {
        batch: {
          file: dashboardPath,
          ops: [
            {
              op: "set_class_list",
              address: { file: dashboardPath, component: "FleetDashboard", root: 2, path: [0, 0] },
              className: "text-3xl",
            },
          ],
        },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result as CallToolResult))).toEqual({ ok: true, errors: [] });
  });

  it("rejects a batch whose address no longer resolves", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "validate_batch",
      arguments: {
        batch: {
          file: dashboardPath,
          ops: [
            {
              op: "set_class_list",
              address: { file: dashboardPath, component: "FleetDashboard", root: 2, path: [0, 99] },
              className: "x",
            },
          ],
        },
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects a batch with a relative file path before it ever reaches validateEditBatch", async () => {
    // Same as the scan_project case above: AbsoluteEditBatchSchema's
    // superRefine rejects this at the schema boundary (an isError result),
    // never reaching validateEditBatch at all — confirmed by the message
    // naming the path problem, not anything validateEditBatch would say.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "validate_batch",
      arguments: {
        batch: {
          file: "src/routes/FleetDashboard.tsx",
          ops: [{ op: "add_import", file: "src/routes/FleetDashboard.tsx", source: "lucide-react", imported: "Truck", localName: "Truck" }],
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result as CallToolResult)).toMatch(/not an absolute path/);
  });
});

describe("MCP server — apply_batch", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "revamp-mcp-test-"));
    tmpFile = path.join(tmpDir, "FleetDashboard.tsx");
    cpSync(dashboardPath, tmpFile);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry-run (write omitted) returns a diff and writes nothing", async () => {
    const before = readFileSync(tmpFile, "utf8");
    const client = await connectedClient();
    const result = await client.callTool({
      name: "apply_batch",
      arguments: {
        batch: {
          file: tmpFile,
          ops: [
            {
              op: "set_class_list",
              address: { file: tmpFile, component: "FleetDashboard", root: 2, path: [0, 0] },
              className: "text-3xl",
            },
          ],
        },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result as CallToolResult));
    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(false);
    expect(parsed.diff).toContain("text-3xl");
    expect(readFileSync(tmpFile, "utf8")).toBe(before); // untouched on disk
  });

  it("write: true actually writes the result to disk", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "apply_batch",
      arguments: {
        batch: {
          file: tmpFile,
          ops: [
            {
              op: "set_class_list",
              address: { file: tmpFile, component: "FleetDashboard", root: 2, path: [0, 0] },
              className: "text-3xl",
            },
          ],
        },
        write: true,
      },
    });
    const parsed = JSON.parse(firstText(result as CallToolResult));
    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(true);
    expect(readFileSync(tmpFile, "utf8")).toContain("text-3xl");
  });

  it("a rejected batch writes nothing, write: true or not", async () => {
    const before = readFileSync(tmpFile, "utf8");
    const client = await connectedClient();
    const result = await client.callTool({
      name: "apply_batch",
      arguments: {
        batch: {
          file: tmpFile,
          ops: [
            {
              op: "set_class_list",
              address: { file: tmpFile, component: "FleetDashboard", root: 2, path: [0, 99] },
              className: "x",
            },
          ],
        },
        write: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(tmpFile, "utf8")).toBe(before);
  });
});
