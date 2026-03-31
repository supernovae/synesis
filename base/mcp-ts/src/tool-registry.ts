/**
 * MCP tool registry — stores tool definitions with JSON Schema input
 * descriptors and async handlers. Serves the GET /mcp/tools catalog
 * and dispatches POST /mcp/tools/call invocations.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, caller?: CallerIdentity) => Promise<unknown>;
}

export interface CallerIdentity {
  org_id?: string;
  tenant_ids?: string[];
  acl_groups?: string[];
  user_id?: string;
}

export interface McpToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpToolRegistry {
  private tools = new Map<string, McpToolDefinition>();

  register(tool: McpToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getCatalog(): McpToolCatalogEntry[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    caller?: CallerIdentity,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpToolNotFoundError(name);
    }
    return tool.handler(args, caller);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }
}

export class McpToolNotFoundError extends Error {
  constructor(name: string) {
    super(`MCP tool not found: ${name}`);
    this.name = "McpToolNotFoundError";
  }
}
