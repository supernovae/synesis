const MAX_MCP_BATCH_SIZE = 16;
const MAX_MCP_METHOD_CHARS = 128;
const MAX_MCP_TOOL_NAME_CHARS = 128;

const JSON_RPC_ENVELOPE_FIELDS = new Set(["jsonrpc", "id", "method", "params"]);
const TOOL_CALL_PARAM_FIELDS = new Set(["name", "arguments", "_meta"]);
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MCP_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);

export type JsonRpcPreflightResult = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAllowedMethod(method: string): boolean {
  return MCP_METHODS.has(method);
}

function hasValidId(id: unknown): boolean {
  return id === undefined || id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function hasValidMetaProgressToken(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 256;
}

function validateToolCallParams(params: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(params)) {
    if (!TOOL_CALL_PARAM_FIELDS.has(key)) return "unknown_tool_call_param";
  }
  if (typeof params.name !== "string" || !params.name.trim()) return "invalid_tool_name";
  const name = params.name.trim();
  if (name.length > MAX_MCP_TOOL_NAME_CHARS || !TOOL_NAME_RE.test(name)) return "invalid_tool_name";
  if (params.arguments !== undefined && !isRecord(params.arguments)) return "tool_arguments_must_be_object";
  if (params._meta !== undefined) {
    if (!isRecord(params._meta)) return "tool_meta_must_be_object";
    for (const key of Object.keys(params._meta)) {
      if (key !== "progressToken") return "unknown_tool_meta_field";
    }
    if (!hasValidMetaProgressToken(params._meta.progressToken)) return "invalid_tool_meta_progress_token";
  }
  return undefined;
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
  if (value.method === "tools/call") {
    if (!isRecord(value.params)) return "params_must_be_object";
    const reason = validateToolCallParams(value.params);
    if (reason) return reason;
  }
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
