/**
 * MCP tool registry — stores tool definitions with JSON Schema input
 * descriptors and async handlers. Serves the GET /mcp/tools catalog
 * and dispatches POST /mcp/tools/call invocations.
 */
export class McpToolRegistry {
    tools = new Map();
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    getCatalog() {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));
    }
    async call(name, args, caller) {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new McpToolNotFoundError(name);
        }
        return tool.handler(args, caller);
    }
    has(name) {
        return this.tools.has(name);
    }
    get size() {
        return this.tools.size;
    }
}
export class McpToolNotFoundError extends Error {
    constructor(name) {
        super(`MCP tool not found: ${name}`);
        this.name = "McpToolNotFoundError";
    }
}
//# sourceMappingURL=tool-registry.js.map