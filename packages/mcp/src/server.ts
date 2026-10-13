import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scanProjectTool, listAddressesTool, validateBatchTool, applyBatchTool } from "./tools.js";

/**
 * Builds the server and registers every tool, but does not connect it to
 * any transport — that's the caller's job (the stdio bin entrypoint for
 * real use, an in-memory transport pair for tests), so the same server
 * construction is exercised either way rather than tests reimplementing
 * their own copy of "what tools exist." Registered one at a time, rather
 * than looped over a list, so each tool's `inputSchema` and `handler`
 * stay a type-checked pair — a loop over a heterogeneous array of tools
 * would need a cast to satisfy `registerTool`'s overloads, and a cast is
 * exactly the kind of thing that silently stops being true later.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "revamp-engine", version: "0.0.1" });
  server.registerTool(scanProjectTool.name, scanProjectTool.config, scanProjectTool.handler);
  server.registerTool(listAddressesTool.name, listAddressesTool.config, listAddressesTool.handler);
  server.registerTool(validateBatchTool.name, validateBatchTool.config, validateBatchTool.handler);
  server.registerTool(applyBatchTool.name, applyBatchTool.config, applyBatchTool.handler);
  return server;
}
