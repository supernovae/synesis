import { z, type ZodType } from "zod";

/** Session context passed to context-aware MCP tool handlers. */
export interface McpToolContext {
  sessionKey: string;
  projectRoot: string;
  userId: string;
  orgId: string;
}

export interface McpToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  handler: (input: TInput, context?: McpToolContext) => TOutput | Promise<TOutput>;
}

export interface McpToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpToolTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`MCP tool '${name}' timed out after ${timeoutMs}ms`);
    this.name = "McpToolTimeoutError";
  }
}

export class McpToolRegistry {
  private tools = new Map<string, McpToolDefinition>();
  private _timeoutMs = 60_000;

  setTimeoutMs(ms: number): void {
    this._timeoutMs = ms;
  }

  register<TInput, TOutput>(tool: McpToolDefinition<TInput, TOutput>): void {
    this.tools.set(tool.name, tool as McpToolDefinition);
  }

  getCatalog(): McpToolCatalogEntry[] {
    const entries: McpToolCatalogEntry[] = [];
    for (const tool of this.tools.values()) {
      entries.push({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
      });
    }
    return entries;
  }

  async call(name: string, args: unknown, context?: McpToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new McpToolNotFoundError(name);
    const parsed = tool.inputSchema.parse(args);
    const timeoutMs = this._timeoutMs;
    return Promise.race([
      Promise.resolve(tool.handler(parsed, context)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new McpToolTimeoutError(name, timeoutMs)), timeoutMs),
      ),
    ]);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

export class McpToolNotFoundError extends Error {
  constructor(name: string) {
    super(`MCP tool not found: ${name}`);
    this.name = "McpToolNotFoundError";
  }
}

/**
 * Minimal Zod-to-JSON-Schema converter for MCP tool discovery.
 * Covers the subset we use (object, string, number, boolean, array, enum).
 */
function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = (schema as z.core.$ZodType)._zod;
  if (!def) return { type: "object" };

  const typeName = def.def?.type;

  if (typeName === "object") {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (shape && typeof shape === "object") {
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as ZodType);
        const innerDef = (value as z.core.$ZodType)?._zod?.def;
        if (innerDef?.type !== "optional" && innerDef?.type !== "default") {
          required.push(key);
        }
      }
    }
    const catchall = (def.def as { catchall?: z.core.$ZodType })?.catchall;
    const additionalProperties = catchall?._zod?.def?.type === "never" ? false : undefined;
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      ...(additionalProperties === false ? { additionalProperties } : {}),
    };
  }
  if (typeName === "string") return { type: "string" };
  if (typeName === "number") return { type: "number" };
  if (typeName === "boolean") return { type: "boolean" };
  if (typeName === "array") return { type: "array", items: zodToJsonSchema((schema as z.ZodArray<ZodType>).element) };
  if (typeName === "enum") {
    const values = (def.def as { values?: readonly string[] })?.values;
    return { type: "string", enum: values ? [...values] : [] };
  }
  if (typeName === "optional" || typeName === "default") {
    const inner = (def.def as { innerType?: ZodType })?.innerType;
    if (inner) return zodToJsonSchema(inner);
  }
  return {};
}
