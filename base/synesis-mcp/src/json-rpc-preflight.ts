const MAX_MCP_BATCH_SIZE = 16;
const MAX_MCP_METHOD_CHARS = 128;

const JSON_RPC_ENVELOPE_FIELDS = new Set(["jsonrpc", "id", "method", "params"]);
const MCP_METHODS = new Set(["initialize", "ping"]);
const MCP_METHOD_PREFIXES = [
  "notifications/",
  "tools/",
  "resources/",
  "prompts/",
  "completion/",
  "logging/",
  "sampling/",
  "roots/",
] as const;

export type JsonRpcPreflightResult = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAllowedMethod(method: string): boolean {
  return MCP_METHODS.has(method) || MCP_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function hasValidId(id: unknown): boolean {
  return id === undefined || id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function validateEnvelope(value: unknown): string | undefined {
  if (!isRecord(value)) return "request_must_be_object";
  for (const key of Object.keys(value)) {
    if (!JSON_RPC_ENVELOPE_FIELDS.has(key)) return "unknown_jsonrpc_field";
  }
  if (value.jsonrpc !== "2.0") return "invalid_jsonrpc_version";
  if (typeof value.method !== "string" || !value.method.trim()) return "invalid_method";
  if (value.method.length > MAX_MCP_METHOD_CHARS) return "method_too_long";
  if (!isAllowedMethod(value.method)) return "unsupported_method";
  if (!hasValidId(value.id)) return "invalid_id";
  if (value.params !== undefined && !isRecord(value.params)) return "params_must_be_object";
  return undefined;
}

export function validateMcpJsonRpcPostBody(body: unknown): JsonRpcPreflightResult {
  if (Array.isArray(body)) {
    if (body.length === 0) return { ok: false, reason: "empty_batch" };
    if (body.length > MAX_MCP_BATCH_SIZE) return { ok: false, reason: "batch_too_large" };
    for (const item of body) {
      const reason = validateEnvelope(item);
      if (reason) return { ok: false, reason };
    }
    return { ok: true };
  }

  const reason = validateEnvelope(body);
  return reason ? { ok: false, reason } : { ok: true };
}
