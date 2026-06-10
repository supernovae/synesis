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

  parseArgs(name: string, args: unknown): { ok: true; args: unknown } | { ok: false; error: McpToolNotFoundError | z.ZodError } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: new McpToolNotFoundError(name) };
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: parsed.error };
    return { ok: true, args: parsed.data };
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

const CATALOG_JSON_SCHEMA_KEYS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "propertyNames",
  "properties",
  "required",
  "type",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closeJsonSchemaMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = closeCatalogJsonSchema(item);
  }
  return out;
}

function closeCatalogJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => closeCatalogJsonSchema(item));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CATALOG_JSON_SCHEMA_KEYS.has(key)) {
      throw new Error(`unsupported_mcp_catalog_schema_key:${key}`);
    }
    if (key === "properties" || key === "$defs") {
      out[key] = closeJsonSchemaMap(item);
    } else {
      out[key] = closeCatalogJsonSchema(item);
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error("unsupported_mcp_catalog_empty_schema");
  }

  const hasBoundedMapSchema = isRecord(out.propertyNames) && isRecord(out.additionalProperties);
  if ((out.type === "object" || isRecord(out.properties)) && !hasBoundedMapSchema) {
    out.type = "object";
    if (!isRecord(out.properties)) out.properties = {};
    out.additionalProperties = false;
  }

  return out;
}

function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  const jsonSchema = converted && typeof converted === "object" && !Array.isArray(converted)
    ? (converted as Record<string, unknown>)
    : { type: "object" };
  return closeCatalogJsonSchema(jsonSchema) as Record<string, unknown>;
}
