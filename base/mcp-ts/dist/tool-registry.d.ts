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
export declare class McpToolRegistry {
    private tools;
    register(tool: McpToolDefinition): void;
    getCatalog(): McpToolCatalogEntry[];
    call(name: string, args: Record<string, unknown>, caller?: CallerIdentity): Promise<unknown>;
    has(name: string): boolean;
    get size(): number;
}
export declare class McpToolNotFoundError extends Error {
    constructor(name: string);
}
