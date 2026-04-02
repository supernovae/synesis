export class McpToolTimeoutError extends Error {
    constructor(name, timeoutMs) {
        super(`MCP tool '${name}' timed out after ${timeoutMs}ms`);
        this.name = "McpToolTimeoutError";
    }
}
export class McpToolRegistry {
    tools = new Map();
    _timeoutMs = 60_000;
    setTimeoutMs(ms) {
        this._timeoutMs = ms;
    }
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    getCatalog() {
        const entries = [];
        for (const tool of this.tools.values()) {
            entries.push({
                name: tool.name,
                description: tool.description,
                inputSchema: zodToJsonSchema(tool.inputSchema),
            });
        }
        return entries;
    }
    async call(name, args) {
        const tool = this.tools.get(name);
        if (!tool)
            throw new McpToolNotFoundError(name);
        const parsed = tool.inputSchema.parse(args);
        const timeoutMs = this._timeoutMs;
        return Promise.race([
            Promise.resolve(tool.handler(parsed)),
            new Promise((_, reject) => setTimeout(() => reject(new McpToolTimeoutError(name, timeoutMs)), timeoutMs)),
        ]);
    }
    has(name) {
        return this.tools.has(name);
    }
}
export class McpToolNotFoundError extends Error {
    constructor(name) {
        super(`MCP tool not found: ${name}`);
        this.name = "McpToolNotFoundError";
    }
}
/**
 * Minimal Zod-to-JSON-Schema converter for MCP tool discovery.
 * Covers the subset we use (object, string, number, boolean, array, enum).
 */
function zodToJsonSchema(schema) {
    const def = schema._zod;
    if (!def)
        return { type: "object" };
    const typeName = def.def?.type;
    if (typeName === "object") {
        const shape = schema.shape;
        const properties = {};
        const required = [];
        if (shape && typeof shape === "object") {
            for (const [key, value] of Object.entries(shape)) {
                properties[key] = zodToJsonSchema(value);
                const innerDef = value?._zod?.def;
                if (innerDef?.type !== "optional" && innerDef?.type !== "default") {
                    required.push(key);
                }
            }
        }
        return { type: "object", properties, ...(required.length ? { required } : {}) };
    }
    if (typeName === "string")
        return { type: "string" };
    if (typeName === "number")
        return { type: "number" };
    if (typeName === "boolean")
        return { type: "boolean" };
    if (typeName === "array")
        return { type: "array", items: zodToJsonSchema(schema.element) };
    if (typeName === "enum") {
        const values = def.def?.values;
        return { type: "string", enum: values ? [...values] : [] };
    }
    if (typeName === "optional" || typeName === "default") {
        const inner = def.def?.innerType;
        if (inner)
            return zodToJsonSchema(inner);
    }
    return {};
}
