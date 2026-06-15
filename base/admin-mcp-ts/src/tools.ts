import { adminApiBaseUrl, type AdminMcpConfig } from "./config.js";
import * as z from "zod/v4";

export type AdminRole = "readonly" | "user" | "org_admin" | "platform_admin" | "admin";

const ROLE_RANK: Record<AdminRole, number> = {
  readonly: 0,
  user: 1,
  org_admin: 2,
  platform_admin: 3,
  admin: 3,
};

export interface SessionUser {
  role: AdminRole;
  username: string;
  user_id: string;
  email?: string;
  org_id: string;
  org_name: string;
  org_roles?: string[];
  tenant_ids?: string[];
  token_scopes?: string[];
}

export interface AdminToolDescriptor {
  name: string;
  description: string;
  min_role: AdminRole;
  inputSchema: ToolInputSchema;
}

export interface ToolContext {
  cfg: AdminMcpConfig;
  delegatedHeaders: Record<string, string>;
  orgHeaders: Record<string, string>;
  userId: string;
  role: string;
  user?: SessionUser;
}

interface AdminToolDefinition extends AdminToolDescriptor {
  invoke: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

interface ToolJsonSchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: ToolJsonSchemaProperty;
  properties?: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ToolInputSchema {
  type: string;
  properties: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

const SUPPORTED_TOOL_SCHEMA_TYPES = new Set(["string", "boolean", "integer", "number", "array", "object"]);
const TOOL_INPUT_SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const TOOL_PROPERTY_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "default",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);

function safeTextSchema(maxLength: number, minLength = 0): ToolJsonSchemaProperty {
  return {
    type: "string",
    ...(minLength > 0 ? { minLength } : {}),
    maxLength,
    pattern: "^[^\\x00-\\x1F\\x7F]*$",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const KNOWLEDGE_GAP_STATUSES = ["open", "resolved", "reopened"] as const;
const INGESTION_ITEM_STATUSES = [
  "pending",
  "failed",
  "dead_letter",
  "indexed",
  "staged_raw",
  "staged_norm",
  "enrich_queued",
] as const;
const INGESTION_CORPUS_CLASSES = ["coder_enriched", "general", "hybrid"] as const;
const INGESTION_CONSTRAINT_KINDS = ["advisory", "guiding", "hard"] as const;
const INGESTION_DISCOVERY_MODES = ["active", "batch"] as const;
const INGESTION_DISCOVERY_HINTS = ["documentation", "api-reference"] as const;
const INGESTION_REVIEW_STATUSES = ["pending", "reviewed", "closed"] as const;
const INGESTION_HANDLERS = [
  "arxiv_paper",
  "devhub_api",
  "devhub_component",
  "devhub_domain",
  "devhub_entity",
  "devhub_resource",
  "devhub_sync",
  "devhub_system",
  "devhub_template",
  "generic_text",
  "github_code",
  "github_markdown",
  "github_repo",
  "html_document",
  "license_spdx",
  "markdown_file",
  "openapi_spec",
  "pdf_document",
  "seed_corpus",
  "structured_data",
  "web_page",
] as const;
const TRACE_SERVICES = ["all", "planner", "yarn"] as const;
const TRACE_DECISION_PATHS = ["abstain", "constrained", "deterministic", "inference_first"] as const;
const MODEL_EFFORT_MODES = ["auto", "pulse", "core", "horizon"] as const;
const GOVERNANCE_SCOPES = ["platform", "org", "tenant", "project", "team"] as const;
const GOVERNANCE_CATEGORIES = ["architecture", "compliance", "process", "quality", "safety", "style", "tooling"] as const;
const OBSERVABILITY_SERVICE_FILTERS = ["planner", "yarn"] as const;
const SECURITY_EVENT_SEVERITIES = ["low", "medium", "high"] as const;
const SECURITY_EVENT_TYPES = [
  "system_override_attempt",
  "jailbreak_roleplay",
  "context_confusion_attack",
  "code_exec_risk",
  "prompt_leakage_attempt",
  "unknown",
  "yarn_policy_reject",
] as const;
const SECURITY_EVENT_SERVICES = ["planner", "yarn"] as const;
const WEB_SEARCH_OUTCOMES = ["success", "error", "empty"] as const;
const WEB_SEARCH_SOURCE_SURFACES = [
  "yarn_chat",
  "yarn_mcp_http",
  "openwebui_planner",
  "planner_internal",
  "external_api",
  "unknown",
] as const;
const MODEL_ROLES = [
  "router",
  "planner",
  "writer",
  "writer-pulse",
  "writer-core",
  "writer-horizon",
  "ambiguity-scorer",
  "critic",
  "coder-pulse",
  "coder-core",
  "coder-horizon",
  "coder-compaction",
  "coder-normalizer",
  "summarizer",
  "indexer-enrich",
  "vision",
] as const;
const YARN_TRANSITION_EVENT_KINDS = [
  "request_trajectory_v1",
  "state_transition_v1",
  "state_transition_quality_calibration_v1",
  "state_transition_quality_global_calibration_v1",
] as const;
const MAX_SESSION_KEY_CANDIDATE_CHARS = 512;
const SESSION_KEY_CANDIDATE_RE = /^[A-Za-z0-9_.:-]{1,512}$/;

function valueMatchesSchemaType(value: unknown, schemaType: string): boolean {
  if (schemaType === "string") return typeof value === "string";
  if (schemaType === "boolean") return typeof value === "boolean";
  if (schemaType === "number") return typeof value === "number" && Number.isFinite(value);
  if (schemaType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (schemaType === "array") return Array.isArray(value);
  if (schemaType === "object") return isRecord(value);
  return false;
}

export class AdminMcpToolError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly privateDetail?: unknown;

  constructor(code: string, statusCode = 500, privateDetail?: unknown) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    this.privateDetail = privateDetail;
  }
}

const activeWatchByUser = new Map<string, number>();

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function boundedString(v: unknown, maxLength: number): string {
  return asString(v).trim().slice(0, maxLength);
}

function asBool(v: unknown, defaultValue = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return defaultValue;
}

function asInt(v: unknown, defaultValue: number, min: number, max: number): number {
  let n = defaultValue;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = Math.trunc(v);
  } else if (typeof v === "string") {
    const parsed = Number.parseInt(v, 10);
    if (Number.isFinite(parsed)) n = parsed;
  }
  return Math.max(min, Math.min(max, n));
}

function asNumber(v: unknown, defaultValue: number, min: number, max: number): number {
  let n = defaultValue;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = v;
  } else if (typeof v === "string") {
    const parsed = Number.parseFloat(v);
    if (Number.isFinite(parsed)) n = parsed;
  }
  return Math.max(min, Math.min(max, n));
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const text = boundedString(item, 128);
    if (text) out.push(text);
    if (out.length >= 50) break;
  }
  return out;
}

function ingestionDiscoveryHints(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const allowed = new Set<string>(INGESTION_DISCOVERY_HINTS);
  const out: string[] = [];
  for (const item of v) {
    const hint = asString(item).trim();
    if (allowed.has(hint) && !out.includes(hint)) out.push(hint);
    if (out.length >= INGESTION_DISCOVERY_HINTS.length) break;
  }
  return out.join(" ");
}

function optionalInt(v: unknown, defaultValue: number, min: number, max: number): number | undefined {
  if (v === undefined || v === null || asString(v).trim() === "") return undefined;
  return asInt(v, defaultValue, min, max);
}

function optionalBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || asString(v).trim() === "") return undefined;
  return asBool(v, false);
}

function isHttpNotFoundError(error: unknown): boolean {
  if (error instanceof AdminMcpToolError) return error.statusCode === 404;
  const message = error instanceof Error ? error.message : String(error);
  return /\(404\)/.test(message);
}

function stripWrappingQuotes(value: string): string {
  let out = value.trim();
  // Strip common wrapper quotes/backticks users often paste.
  while (
    out.length >= 2
    && (
      (out.startsWith("\"") && out.endsWith("\""))
      || (out.startsWith("'") && out.endsWith("'"))
      || (out.startsWith("`") && out.endsWith("`"))
    )
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

export function buildSessionKeyCandidates(rawInput: unknown): string[] {
  const raw = asString(rawInput).trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (value: string) => {
    const v = value.trim();
    if (v.length > MAX_SESSION_KEY_CANDIDATE_CHARS || !SESSION_KEY_CANDIDATE_RE.test(v)) return;
    if (!v || out.includes(v)) return;
    out.push(v);
  };

  const stripped = stripWrappingQuotes(raw);
  const sources = [stripped];
  if (/%[0-9a-f]{2}/i.test(stripped)) {
    try {
      sources.push(decodeURIComponent(stripped));
    } catch {
      // Ignore malformed encoded values.
    }
  }

  for (const source of sources) {
    add(source);

    // If user pasted surrounding text, recover explicit synesis session keys.
    for (const match of source.matchAll(/synesis:[A-Za-z0-9_.:-]{1,512}/gi)) {
      add(match[0]);
    }

    // If a full key was provided, also keep just the trailing UUID conversation tail
    // for fuzzy fallback matching against recent sessions.
    const tailMatch = source.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    if (tailMatch) add(tailMatch[0]);
  }

  return out;
}

async function resolveSessionKeyFromRecentSessions(
  ctx: ToolContext,
  candidates: string[],
): Promise<string | null> {
  const lowerCandidates = candidates.map((v) => v.toLowerCase());
  let page = 1;
  const pageSize = 100;
  let total = Number.POSITIVE_INFINITY;

  while ((page - 1) * pageSize < total && page <= 10) {
    const payload = await apiRequest(ctx, "GET", "/api/v1/yarn/sessions", {
      page,
      page_size: pageSize,
      active_since_hours: 8760,
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) break;
    const record = payload as { sessions?: unknown; total?: unknown };
    const sessions = Array.isArray(record.sessions) ? record.sessions : [];
    total = typeof record.total === "number" && Number.isFinite(record.total) ? record.total : sessions.length;

    for (const row of sessions) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const session = row as { session_key?: unknown; conversation_id?: unknown };
      const key = asString(session.session_key).trim();
      const conversationId = asString(session.conversation_id).trim();
      if (!key) continue;
      const lowerKey = key.toLowerCase();
      const lowerConversation = conversationId.toLowerCase();
      if (
        lowerCandidates.includes(lowerKey)
        || lowerCandidates.includes(lowerConversation)
        || lowerCandidates.some((candidate) => candidate.length >= 8 && lowerKey.endsWith(candidate))
      ) {
        return key;
      }
    }
    page += 1;
  }

  return null;
}

function queryString(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      if (!v.trim()) continue;
      q.set(k, v);
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      q.set(k, String(v));
      continue;
    }
    if (typeof v === "boolean") {
      q.set(k, v ? "true" : "false");
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        const text = asString(item).trim();
        if (!text) continue;
        q.append(k, text);
      }
    }
  }
  const built = q.toString();
  return built ? `?${built}` : "";
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildApiUrl(ctx: ToolContext, path: string, params?: Record<string, unknown>): string {
  const base = adminApiBaseUrl(ctx.cfg);
  return `${base}${path}${queryString(params ?? {})}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AdminMcpToolError("upstream_timeout", 504, { url });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(
  ctx: ToolContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  params?: Record<string, unknown>,
  body?: unknown,
): Promise<unknown> {
  const url = buildApiUrl(ctx, path, params);
  const headers: Record<string, string> = {
    ...ctx.delegatedHeaders,
    ...ctx.orgHeaders,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ctx.cfg.SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS,
  );
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    throw new AdminMcpToolError("upstream_request_failed", response.status, {
      method,
      path,
      status: response.status,
      detail,
    });
  }
  return parsed;
}

async function plannerRequest(ctx: ToolContext, path: string, body: Record<string, unknown>): Promise<unknown> {
  const token = ctx.cfg.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN || ctx.cfg.SYNESIS_INTERNAL_SERVICE_TOKEN;
  if (!token.trim()) {
    throw new AdminMcpToolError("planner_token_unconfigured", 503);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-synesis-service-token": token,
    "x-synesis-service-name": "synesis-admin-mcp-ts",
  };
  if (ctx.userId) headers["x-openwebui-user-id"] = ctx.userId;
  const orgId = ctx.orgHeaders["x-synesis-org-id"] || ctx.orgHeaders["x-active-org-id"] || ctx.user?.org_id || "";
  if (orgId) headers["x-synesis-org-id"] = orgId;

  const url = `${ctx.cfg.SYNESIS_PLANNER_URL.replace(/\/$/, "")}${path}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    ctx.cfg.SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS,
  );
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    throw new AdminMcpToolError("planner_request_failed", response.status, { path, status: response.status, parsed });
  }
  return parsed;
}

function strictPropertySchema(schema: ToolJsonSchemaProperty): ToolJsonSchemaProperty {
  for (const key of Object.keys(schema)) {
    if (!TOOL_PROPERTY_SCHEMA_KEYS.has(key)) {
      throw new Error("unsupported_tool_schema_property_key");
    }
  }
  const schemaType = schema.type;
  if (typeof schemaType !== "string" || !SUPPORTED_TOOL_SCHEMA_TYPES.has(schemaType)) {
    throw new Error("unsupported_tool_schema_type");
  }
  if (schema.items !== undefined && schemaType !== "array") {
    throw new Error("unsupported_tool_schema_items_key");
  }
  if (schema.properties !== undefined && schemaType !== "object") {
    throw new Error("unsupported_tool_schema_properties_key");
  }
  if (schema.required !== undefined && schemaType !== "object") {
    throw new Error("unsupported_tool_schema_required_key");
  }
  if (schema.additionalProperties !== undefined && (schemaType !== "object" || schema.additionalProperties !== false)) {
    throw new Error("unsupported_tool_schema_additional_properties");
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schemaType === "array" || schemaType === "object") {
      throw new Error("unsupported_tool_schema_enum");
    }
    for (const enumValue of schema.enum) {
      if (!valueMatchesSchemaType(enumValue, schemaType)) {
        throw new Error("unsupported_tool_schema_enum_value");
      }
    }
  }
  if (schema.default !== undefined && !valueMatchesSchemaType(schema.default, schemaType)) {
    throw new Error("unsupported_tool_schema_default_value");
  }
  if (schemaType === "array" && !schema.items) {
    throw new Error("unsupported_tool_schema_array_without_items");
  }
  if (schemaType === "object" && !isRecord(schema.properties)) {
    throw new Error("unsupported_tool_schema_object_without_properties");
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error("unsupported_tool_schema_required_key");
  }
  for (const requiredKey of schema.required ?? []) {
    if (typeof requiredKey !== "string" || !(requiredKey in (schema.properties ?? {}))) {
      throw new Error("unsupported_tool_schema_required_key");
    }
  }

  const next: ToolJsonSchemaProperty = { ...schema };
  if (schema.items) {
    next.items = strictPropertySchema(schema.items);
  }
  if (schema.type === "object") {
    const properties: Record<string, ToolJsonSchemaProperty> = {};
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      properties[key] = strictPropertySchema(propertySchema);
    }
    next.properties = properties;
    next.additionalProperties = false;
  }
  return next;
}

function strictInputSchema(schema: ToolInputSchema): ToolInputSchema {
  for (const key of Object.keys(schema)) {
    if (!TOOL_INPUT_SCHEMA_KEYS.has(key)) {
      throw new Error("unsupported_tool_schema_root_key");
    }
  }
  if (schema.type !== "object") {
    throw new Error("unsupported_tool_schema_root_type");
  }
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new Error("unsupported_tool_schema_root_without_properties");
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error("unsupported_tool_schema_additional_properties");
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error("unsupported_tool_schema_required_key");
  }
  const properties: Record<string, ToolJsonSchemaProperty> = {};
  for (const requiredKey of schema.required ?? []) {
    if (typeof requiredKey !== "string" || !(requiredKey in schema.properties)) {
      throw new Error("unsupported_tool_schema_required_key");
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    properties[key] = strictPropertySchema(propertySchema);
  }
  return { ...schema, properties, additionalProperties: false };
}

function zodForProperty(schema: ToolJsonSchemaProperty): z.ZodType {
  let out: z.ZodType;
  if (schema.type === "string") {
    out = z.string();
  } else if (schema.type === "boolean") {
    out = z.boolean();
  } else if (schema.type === "integer") {
    out = z.number().int();
  } else if (schema.type === "number") {
    out = z.number();
  } else if (schema.type === "array") {
    if (!schema.items) throw new Error("unsupported_tool_schema_array_without_items");
    out = z.array(zodForProperty(schema.items));
  } else if (schema.type === "object") {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      shape[key] = zodForProperty(propertySchema).optional();
    }
    out = z.object(shape).strict();
  } else {
    throw new Error("unsupported_tool_schema_type");
  }
  if (schema.enum) {
    out = out.refine((value) => schema.enum?.includes(value), { message: "Unsupported value" });
  }
  if (schema.type === "string" && typeof schema.minLength === "number") {
    out = (out as z.ZodString).min(schema.minLength);
  }
  if (schema.type === "string" && typeof schema.maxLength === "number") {
    out = (out as z.ZodString).max(schema.maxLength);
  }
  if (schema.type === "string" && schema.pattern) {
    out = (out as z.ZodString).regex(new RegExp(schema.pattern));
  }
  return out;
}

export function zodInputSchemaForTool(schema: ToolInputSchema): z.ZodType {
  const strictSchema = strictInputSchema(schema);
  const shape: Record<string, z.ZodType> = {};
  const required = new Set(strictSchema.required ?? []);
  for (const [key, propertySchema] of Object.entries(strictSchema.properties)) {
    const zodProperty = zodForProperty(propertySchema);
    shape[key] = required.has(key) ? zodProperty : zodProperty.optional();
  }
  return z.object(shape).strict();
}

function validateValueAgainstSchema(
  tool: string,
  key: string,
  value: unknown,
  schema: ToolJsonSchemaProperty,
): void {
  if (typeof schema.type !== "string" || !SUPPORTED_TOOL_SCHEMA_TYPES.has(schema.type)) {
    throw new AdminMcpToolError("invalid_tool_schema", 500, { reason: "unsupported_type", key, tool });
  }
  if (value === undefined || value === null) return;
  if (schema.enum && !schema.enum.includes(value)) {
    throw new AdminMcpToolError("invalid_arguments", 400, {
      reason: "invalid_enum",
      key,
      tool,
      allowed: schema.enum,
    });
  }
  if (schema.type === "string" && typeof value !== "string") {
    throw new AdminMcpToolError("invalid_arguments", 400, { reason: "invalid_type", key, tool, expected: "string" });
  }
  if (schema.type === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      throw new AdminMcpToolError("invalid_arguments", 400, {
        reason: "string_too_short",
        key,
        tool,
        minLength: schema.minLength,
      });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      throw new AdminMcpToolError("invalid_arguments", 400, {
        reason: "string_too_long",
        key,
        tool,
        maxLength: schema.maxLength,
      });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new AdminMcpToolError("invalid_arguments", 400, {
        reason: "pattern_mismatch",
        key,
        tool,
        pattern: schema.pattern,
      });
    }
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new AdminMcpToolError("invalid_arguments", 400, { reason: "invalid_type", key, tool, expected: "boolean" });
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new AdminMcpToolError("invalid_arguments", 400, { reason: "invalid_type", key, tool, expected: "number" });
  }
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    throw new AdminMcpToolError("invalid_arguments", 400, { reason: "invalid_type", key, tool, expected: "integer" });
  }
  if (schema.type === "array") {
    if (!schema.items) {
      throw new AdminMcpToolError("invalid_tool_schema", 500, { reason: "array_without_items", key, tool });
    }
    if (!Array.isArray(value)) {
      throw new AdminMcpToolError("invalid_arguments", 400, { reason: "invalid_type", key, tool, expected: "array" });
    }
    for (const [idx, item] of value.entries()) {
      validateValueAgainstSchema(tool, `${key}.${idx}`, item, schema.items);
    }
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AdminMcpToolError("invalid_arguments", 400, { reason: "invalid_type", key, tool, expected: "object" });
    }
    const nested = value as Record<string, unknown>;
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const nestedKey of Object.keys(nested)) {
      if (!allowed.has(nestedKey)) {
        throw new AdminMcpToolError("invalid_arguments", 400, {
          reason: "unknown_argument",
          key: `${key}.${nestedKey}`,
          tool,
        });
      }
    }
    for (const requiredKey of schema.required ?? []) {
      if (nested[requiredKey] === undefined || nested[requiredKey] === null || asString(nested[requiredKey]).trim() === "") {
        throw new AdminMcpToolError("invalid_arguments", 400, {
          reason: "missing_required",
          key: `${key}.${requiredKey}`,
          tool,
        });
      }
    }
    for (const [nestedKey, nestedSchema] of Object.entries(schema.properties ?? {})) {
      validateValueAgainstSchema(tool, `${key}.${nestedKey}`, nested[nestedKey], nestedSchema);
    }
  }
}

function validateToolArgs(tool: AdminToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const schema = strictInputSchema(tool.inputSchema);
  const properties = schema.properties;
  const allowed = new Set(Object.keys(properties));
  const required = Array.isArray(tool.inputSchema.required)
    ? (tool.inputSchema.required as unknown[]).map((v) => asString(v)).filter(Boolean)
    : [];
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new AdminMcpToolError("invalid_arguments", 400, { reason: "unknown_argument", key, tool: tool.name });
    }
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || asString(args[key]).trim() === "") {
      throw new AdminMcpToolError("invalid_arguments", 400, { reason: "missing_required", key, tool: tool.name });
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    validateValueAgainstSchema(tool.name, key, args[key], propertySchema);
  }
  return args;
}

function sanitizeValueForSchema(value: unknown, schema: ToolJsonSchemaProperty): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (schema.type === "object") {
    if (!isRecord(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, nestedSchema] of Object.entries(schema.properties ?? {})) {
      const sanitized = sanitizeValueForSchema(value[key], nestedSchema);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || !schema.items) return undefined;
    return value
      .map((item) => sanitizeValueForSchema(item, schema.items as ToolJsonSchemaProperty))
      .filter((item) => item !== undefined);
  }
  return value;
}

export function sanitizeIngestionConfig(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeValueForSchema(value, INGESTION_CONFIG_SCHEMA);
  return isRecord(sanitized) ? sanitized : undefined;
}

async function getTransitionQuality(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const sinceHours = asInt(args.since_hours, 168, 1, 720);
  const bucketMinutes = asInt(args.bucket_minutes, 60, 5, 60);
  return apiRequest(
    ctx,
    "GET",
    "/api/v1/yarn/transition-quality",
    { since_hours: sinceHours, bucket_minutes: bucketMinutes },
  );
}

async function getTransitionEvents(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const sinceMinutes = asInt(args.since_minutes, 60, 1, 1440);
  const limit = asInt(args.limit, 100, 1, 500);
  const afterId = asInt(args.after_id, 0, 0, Number.MAX_SAFE_INTEGER);
  const riskOnly = asBool(args.risk_only, true);
  const includeMetadata = asBool(args.include_metadata, false);
  if (includeMetadata && roleRank(ctx.role) < ROLE_RANK.platform_admin) {
    throw new AdminMcpToolError("forbidden", 403, { reason: "raw_metadata_requires_platform_admin" });
  }
  const eventKinds = asStringArray(args.event_kinds);
  return apiRequest(
    ctx,
    "GET",
    "/api/v1/yarn/transition-events",
    {
      since_minutes: sinceMinutes,
      limit,
      after_id: afterId,
      risk_only: riskOnly,
      include_metadata: includeMetadata,
      event_kinds: eventKinds,
    },
  );
}

function getTool(
  name: string,
  description: string,
  minRole: AdminRole,
  inputSchema: ToolInputSchema,
  path: string | ((args: Record<string, unknown>) => string),
  params?: (args: Record<string, unknown>) => Record<string, unknown>,
): AdminToolDefinition {
  return {
    name,
    description,
    min_role: minRole,
    inputSchema: strictInputSchema(inputSchema),
    invoke: async (ctx, args) => {
      const resolvedPath = typeof path === "function" ? path(args) : path;
      return apiRequest(ctx, "GET", resolvedPath, params ? params(args) : undefined);
    },
  };
}

function postTool(
  name: string,
  description: string,
  minRole: AdminRole,
  inputSchema: ToolInputSchema,
  path: string | ((args: Record<string, unknown>) => string),
  body?: (args: Record<string, unknown>) => Record<string, unknown>,
  params?: (args: Record<string, unknown>) => Record<string, unknown>,
): AdminToolDefinition {
  return {
    name,
    description,
    min_role: minRole,
    inputSchema: strictInputSchema(inputSchema),
    invoke: async (ctx, args) => {
      const resolvedPath = typeof path === "function" ? path(args) : path;
      return apiRequest(ctx, "POST", resolvedPath, params ? params(args) : undefined, body ? body(args) : {});
    },
  };
}

function patchTool(
  name: string,
  description: string,
  minRole: AdminRole,
  inputSchema: ToolInputSchema,
  path: string | ((args: Record<string, unknown>) => string),
  body?: (args: Record<string, unknown>) => Record<string, unknown>,
  params?: (args: Record<string, unknown>) => Record<string, unknown>,
): AdminToolDefinition {
  return {
    name,
    description,
    min_role: minRole,
    inputSchema: strictInputSchema(inputSchema),
    invoke: async (ctx, args) => {
      const resolvedPath = typeof path === "function" ? path(args) : path;
      return apiRequest(ctx, "PATCH", resolvedPath, params ? params(args) : undefined, body ? body(args) : {});
    },
  };
}

type NoArgToolRow = readonly [name: string, description: string, minRole: AdminRole, path: string];

function noArgGetTools(rows: readonly NoArgToolRow[]): AdminToolDefinition[] {
  return rows.map(([name, description, minRole, path]) => getTool(name, description, minRole, EMPTY_SCHEMA, path));
}

function noArgPostTools(rows: readonly NoArgToolRow[]): AdminToolDefinition[] {
  return rows.map(([name, description, minRole, path]) => postTool(name, description, minRole, EMPTY_SCHEMA, path));
}

const EMPTY_SCHEMA = { type: "object", properties: {} };
const SINCE_HOURS_SCHEMA = {
  type: "object",
  properties: {
    since_hours: { type: "integer", default: 24, description: "Lookback hours" },
  },
};
const DAYS_SCHEMA = {
  type: "object",
  properties: {
    days: { type: "integer", default: 7, description: "Lookback days" },
  },
};
const INGESTION_SYNESIS_META_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: safeTextSchema(32),
    languages: { type: "array", items: safeTextSchema(32) },
    artifact_kind: safeTextSchema(32),
    corpus_class: { type: "string", enum: [...INGESTION_CORPUS_CLASSES] },
    content_profile: safeTextSchema(32),
    freshness_sla_days: { type: "integer" },
    scope_tags: { type: "array", items: safeTextSchema(64) },
    golden_path_id: safeTextSchema(128),
    validation_recipe_id: safeTextSchema(128),
    source_owner: safeTextSchema(128),
    review_status: { type: "string", enum: [...INGESTION_REVIEW_STATUSES] },
    backstage_entity_ref: safeTextSchema(256),
    constraint_domain: safeTextSchema(64),
    constraint_kind: { type: "string", enum: [...INGESTION_CONSTRAINT_KINDS] },
    constraint_source: safeTextSchema(64),
    constraint_confidence: { type: "number" },
  },
};
const INGESTION_DISCOVERY_REPORT_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    handler: { type: "string", enum: [...INGESTION_HANDLERS] },
    domain: safeTextSchema(128),
    title: safeTextSchema(512),
    tags: { type: "array", items: safeTextSchema(64) },
    risk_flags: { type: "array", items: safeTextSchema(128) },
    recommended_mode: { type: "string", enum: [...INGESTION_DISCOVERY_MODES] },
    notes: { type: "array", items: safeTextSchema(512) },
    suggested_corpus_class: { type: "string", enum: [...INGESTION_CORPUS_CLASSES] },
  },
};
const PUBLIC_HTTP_URL_PATTERN = "^https?://(?!(?:localhost|localhost\\.localdomain)(?::|/|$))(?!(?:127\\.|10\\.|192\\.168\\.|169\\.254\\.|0\\.|172\\.(?:1[6-9]|2\\d|3[01])\\.))[^\\s\\x00-\\x1F\\x7F@]+$";
const INGESTION_PREFIX_PATTERN = "^(https?://(?!(?:localhost|localhost\\.localdomain)(?::|/|$))(?!(?:127\\.|10\\.|192\\.168\\.|169\\.254\\.|0\\.|172\\.(?:1[6-9]|2\\d|3[01])\\.))[^\\s\\x00-\\x1F\\x7F@]+|/[^\\x00-\\x1F\\x7F]*)$";
const INGESTION_PUBLIC_URL_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  pattern: PUBLIC_HTTP_URL_PATTERN,
};
const INGESTION_PREFIX_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  pattern: INGESTION_PREFIX_PATTERN,
};
const INGESTION_ARXIV_PAPER_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: safeTextSchema(64, 1),
    title: safeTextSchema(512),
  },
  required: ["id"],
};
const INGESTION_SPDX_CONFIG_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    licenses_url: INGESTION_PUBLIC_URL_SCHEMA,
    details_base_url: INGESTION_PUBLIC_URL_SCHEMA,
  },
  required: ["licenses_url"],
};
const INGESTION_FEDORA_CONFIG_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    repo_url: INGESTION_PUBLIC_URL_SCHEMA,
    common_licenses: { type: "array", items: safeTextSchema(128, 1) },
  },
  required: ["repo_url"],
};
const INGESTION_CHOOSEALICENSE_CONFIG_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    repo: safeTextSchema(256, 1),
    branch: safeTextSchema(128),
    licenses_path: safeTextSchema(512),
  },
  required: ["repo"],
};
const INGESTION_CONFIG_SCHEMA: ToolJsonSchemaProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: INGESTION_PUBLIC_URL_SCHEMA,
    path: safeTextSchema(2048),
    branch: safeTextSchema(128),
    paths: { type: "array", items: safeTextSchema(2048) },
    discovery: safeTextSchema(64),
    follow_links: { type: "boolean" },
    max_depth: { type: "integer" },
    max_pages: { type: "integer" },
    respect_robots: { type: "boolean" },
    min_request_interval: { type: "number" },
    allowed_prefixes: { type: "array", items: INGESTION_PREFIX_SCHEMA },
    blocked_prefixes: { type: "array", items: INGESTION_PREFIX_SCHEMA },
    allow_blog: { type: "boolean" },
    disallow_dotted_first_path_segment: { type: "boolean" },
    max_sitemap_expand: { type: "integer" },
    max_links_per_page: { type: "integer" },
    profile: safeTextSchema(64),
    user_agent: safeTextSchema(256),
    format: safeTextSchema(32),
    tags: { type: "array", items: safeTextSchema(64) },
    repo: safeTextSchema(256),
    language: safeTextSchema(32),
    doc_id_prefix: safeTextSchema(128),
    context_prefix: safeTextSchema(2000),
    inline_content: safeTextSchema(200000),
    devhub_entity_ref: safeTextSchema(256),
    papers: { type: "array", items: INGESTION_ARXIV_PAPER_SCHEMA },
    spdx: INGESTION_SPDX_CONFIG_SCHEMA,
    fedora: INGESTION_FEDORA_CONFIG_SCHEMA,
    choosealicense: INGESTION_CHOOSEALICENSE_CONFIG_SCHEMA,
    compat_path: safeTextSchema(2048),
    synesis_meta: INGESTION_SYNESIS_META_SCHEMA,
    discovery_report: INGESTION_DISCOVERY_REPORT_SCHEMA,
    preflight_at: safeTextSchema(64),
  },
};
const TRACE_ID_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9_.:-]+$",
};
const IDENTIFIER_64_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9_.:-]+$",
};
const IDENTIFIER_128_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_.:-]+$",
};
const MODEL_ID_256_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\x00-\\x1F\\x7F]*$",
};
const MODEL_ROLE_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  enum: [...MODEL_ROLES],
};
const SAFE_TEXT_64_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  maxLength: 64,
  pattern: "^[^\\x00-\\x1F\\x7F]*$",
};
const SAFE_TEXT_128_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  maxLength: 128,
  pattern: "^[^\\x00-\\x1F\\x7F]*$",
};
const SAFE_TEXT_256_SCHEMA: ToolJsonSchemaProperty = {
  type: "string",
  maxLength: 256,
  pattern: "^[^\\x00-\\x1F\\x7F]*$",
};

const TOOL_DEFINITIONS: AdminToolDefinition[] = [
  getTool(
    "list_traces",
    "List recent traces with optional filters (same data as GET /api/v1/traces). Supports trace_service, conversation_id, decision_path, tenant_id, and offset.",
    "org_admin",
    {
      type: "object",
      properties: {
        limit: { type: "integer", default: 20, description: "Max results (max 100)" },
        offset: { type: "integer", default: 0, description: "Pagination offset" },
        has_error: { type: "boolean", description: "Filter error traces" },
        task_type: { ...SAFE_TEXT_128_SCHEMA, description: "Filter by task type" },
        since_hours: { type: "integer", description: "If set, only traces newer than this many hours ago" },
        trace_service: { type: "string", enum: [...TRACE_SERVICES], description: "Filter by emitter: planner, yarn, or all" },
        conversation_id: { ...SAFE_TEXT_128_SCHEMA, description: "Filter by conversation / session id" },
        decision_path: { type: "string", enum: [...TRACE_DECISION_PATHS], description: "Filter by routing path" },
        tenant_id: { ...SAFE_TEXT_64_SCHEMA, description: "Optional tenant filter" },
        user_id: { ...SAFE_TEXT_256_SCHEMA, description: "Optional user id filter (within RBAC scope)" },
        org_id: { ...SAFE_TEXT_256_SCHEMA, description: "Optional org id filter (within RBAC scope)" },
      },
    },
    "/api/v1/traces",
    (args) => {
      const sinceHours = asInt(args.since_hours, 0, 0, 720);
      return {
        limit: asInt(args.limit, 20, 1, 100),
        offset: asInt(args.offset, 0, 0, 100_000),
        has_error: typeof args.has_error === "boolean" ? args.has_error : undefined,
        task_type: boundedString(args.task_type, 128),
        trace_service: boundedString(args.trace_service, 32),
        conversation_id: boundedString(args.conversation_id, 128),
        decision_path: boundedString(args.decision_path, 128),
        tenant_id: boundedString(args.tenant_id, 64),
        user_id: boundedString(args.user_id, 256),
        org_id: boundedString(args.org_id, 256),
        since: sinceHours > 0 ? nowUnixSeconds() - sinceHours * 3600 : undefined,
      };
    },
  ),
  getTool(
    "get_trace",
    "Get full detail for a single trace by ID. Scoped to the caller role.",
    "org_admin",
    {
      type: "object",
      properties: { trace_id: { ...TRACE_ID_SCHEMA, description: "The trace ID to look up" } },
      required: ["trace_id"],
    },
    (args) => {
      const traceId = boundedString(args.trace_id, 64);
      if (!traceId) throw new Error("trace_id required");
      return `/api/v1/traces/${encodeURIComponent(traceId)}`;
    },
  ),
  getTool("trace_stats", "Aggregate trace statistics (last 24h), same as GET /api/v1/traces/stats.", "org_admin", EMPTY_SCHEMA, "/api/v1/traces/stats"),
  getTool(
    "trace_decision_analytics",
    "Decision-path and verification analytics from trace JSONB (GET /api/v1/traces/analytics).",
    "org_admin",
    {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24, description: "Start of window in hours ago" },
        org_id: { ...SAFE_TEXT_256_SCHEMA, description: "Optional org filter" },
      },
    },
    "/api/v1/traces/analytics",
    (args) => {
      const sinceHours = asInt(args.since_hours, 24, 1, 720);
      return {
        since: nowUnixSeconds() - sinceHours * 3600,
        org_id: boundedString(args.org_id, 128),
      };
    },
  ),
  getTool("usage_summary", "Pre-aggregated usage/cost summary from usage traces (GET /api/v1/usage/summary).", "org_admin", SINCE_HOURS_SCHEMA, "/api/v1/usage/summary", (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 720) })),
  getTool("usage_time_series", "Hourly usage buckets (GET /api/v1/usage).", "org_admin", SINCE_HOURS_SCHEMA, "/api/v1/usage", (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 720) })),
  getTool("unified_usage_snapshot", "Full usage and cost snapshot: pipeline trace totals + Yarn usage for org_admin+ (GET /api/v1/usage/summary-unified).", "org_admin", SINCE_HOURS_SCHEMA, "/api/v1/usage/summary-unified", (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 720) })),
  {
    name: "synesis_search",
    description: "Search the Synesis knowledge corpus through Planner knowledge search.",
    min_role: "user",
    inputSchema: {
      type: "object",
      properties: {
        query: { ...safeTextSchema(4000, 1), description: "Natural language search query" },
        top_k: { type: "integer", default: 5, description: "Max results" },
        domain: { ...safeTextSchema(128), description: "Optional domain filter" },
      },
      required: ["query"],
    },
    invoke: async (ctx, args) => {
      const query = boundedString(args.query, 4000);
      if (!query) throw new AdminMcpToolError("invalid_arguments", 400, { reason: "query_required" });
      return plannerRequest(ctx, "/v1/knowledge/search", {
        query,
        top_k: asInt(args.top_k, 5, 1, 50),
        domain: boundedString(args.domain, 128),
      });
    },
  },
  {
    name: "synesis_classify_intent",
    description: "Classify a developer query into task, complexity, and domain hints for routing and support.",
    min_role: "user",
    inputSchema: {
      type: "object",
      properties: {
        query: { ...safeTextSchema(8000, 1), description: "The developer query to classify" },
      },
      required: ["query"],
    },
    invoke: async (_ctx, args) => {
      const query = boundedString(args.query, 8000).toLowerCase();
      if (!query) throw new AdminMcpToolError("invalid_arguments", 400, { reason: "query_required" });

      const categories: string[] = [];
      const hasAny = (words: string[]) => words.some((word) => query.includes(word));
      if (hasAny(["debug", "error", "fix", "crash", "traceback", "exception"])) categories.push("debugging");
      if (hasAny(["deploy", "kubernetes", "openshift", "helm", "container"])) categories.push("operations");
      if (hasAny(["test", "pytest", "coverage", "assert", "vitest"])) categories.push("testing");
      if (hasAny(["refactor", "rename", "extract", "clean"])) categories.push("refactoring");
      if (hasAny(["api", "endpoint", "route", "rest", "graphql"])) categories.push("api_design");
      if (hasAny(["security", "auth", "rbac", "token", "jwt"])) categories.push("security");
      if (categories.length === 0) categories.push("general_coding");

      const wordCount = query.split(/\s+/).filter(Boolean).length;
      let complexity = "simple";
      if (wordCount > 20) complexity = "moderate";
      if (wordCount > 50 || hasAny(["architecture", "architect", "design", "system"])) complexity = "complex";
      return { categories, complexity, query_length: query.length, word_count: wordCount };
    },
  },
  postTool(
    "synesis_retrieval_gaps",
    "Report a retrieval gap to the curator pipeline when the corpus could not answer a user question.",
    "user",
    {
      type: "object",
      properties: {
        query: { ...safeTextSchema(2000, 1), description: "The question that had no good answer" },
        context: { ...safeTextSchema(2000), description: "What the user was trying to do" },
        language: { ...safeTextSchema(32), description: "Optional language or technology label" },
        platform_context: { ...safeTextSchema(64), description: "Optional platform/domain context" },
      },
      required: ["query"],
    },
    "/api/v1/observability/knowledge-gaps/report",
    (args) => ({
      query: boundedString(args.query, 2000),
      context: boundedString(args.context, 2000),
      language: boundedString(args.language, 32),
      platform_context: boundedString(args.platform_context, 64) || "generic",
    }),
  ),
  getTool(
    "cache_history",
    "Time-series prefix-cache snapshots from Admin observability.",
    "org_admin",
    {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        service: { type: "string", enum: [...OBSERVABILITY_SERVICE_FILTERS], description: "Optional service filter: planner or yarn" },
      },
    },
    "/api/v1/observability/cache/history",
    (args) => ({
      since_hours: asInt(args.since_hours, 24, 1, 720),
      service: boundedString(args.service, 32),
    }),
  ),
  getTool(
    "cache_token_economics",
    "Roll up Yarn token-economics and cache-policy decision events.",
    "org_admin",
    {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        limit: { type: "integer", default: 5000 },
      },
    },
    "/api/v1/observability/cache/token-economics",
    (args) => ({
      since_hours: asInt(args.since_hours, 24, 1, 720),
      limit: asInt(args.limit, 5000, 100, 50000),
    }),
  ),
  getTool(
    "cache_canary_report",
    "Latest provider cache canary report generated by CI or operator automation.",
    "org_admin",
    EMPTY_SCHEMA,
    "/api/v1/observability/cache/canary-report",
  ),
  getTool(
    "compaction_metrics",
    "Time-series prompt/output/log compaction snapshots.",
    "user",
    {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        service: { type: "string", enum: [...OBSERVABILITY_SERVICE_FILTERS], description: "Optional service filter: planner or yarn" },
      },
    },
    "/api/v1/observability/compaction",
    (args) => ({
      since_hours: asInt(args.since_hours, 24, 1, 720),
      service: boundedString(args.service, 32),
    }),
  ),
  getTool("authz_stats", "Authorization engine stats for the current authenticated context.", "user", EMPTY_SCHEMA, "/api/v1/observability/authz"),
  getTool(
    "failure_list",
    "List coding/runtime failure records with filters.",
    "org_admin",
    {
      type: "object",
      properties: {
        language: safeTextSchema(64),
        error_type: safeTextSchema(128),
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 20 },
      },
    },
    "/api/v1/observability/failures",
    (args) => ({
      language: boundedString(args.language, 64),
      error_type: boundedString(args.error_type, 128),
      page: asInt(args.page, 1, 1, 10_000),
      page_size: asInt(args.page_size, 20, 1, 100),
    }),
  ),
  getTool("failure_stats", "Aggregate failure counts by language, error type, and resolution status.", "org_admin", EMPTY_SCHEMA, "/api/v1/observability/failures/stats"),
  getTool(
    "failure_detail",
    "Fetch a single failure record by failure_id.",
    "org_admin",
    {
      type: "object",
      properties: { failure_id: { ...IDENTIFIER_128_SCHEMA, description: "Failure identifier" } },
      required: ["failure_id"],
    },
    (args) => `/api/v1/observability/failures/${encodeURIComponent(boundedString(args.failure_id, 128))}`,
  ),
  getTool(
    "knowledge_gaps",
    "List open/resolved retrieval knowledge gaps.",
    "org_admin",
    {
      type: "object",
      properties: {
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 20 },
        status: { type: "string", enum: [...KNOWLEDGE_GAP_STATUSES], description: "Knowledge gap status" },
      },
    },
    "/api/v1/observability/knowledge-gaps",
    (args) => ({
      page: asInt(args.page, 1, 1, 10_000),
      page_size: asInt(args.page_size, 20, 1, 100),
      status: boundedString(args.status, 32),
    }),
  ),
  ...noArgGetTools([
    ["fga_status", "OpenFGA authorization engine status and recent evaluation events. Platform admin only.", "platform_admin", "/api/v1/observability/fga-status"],
    ["token_fga_explain", "Explain the current user's token scopes and FGA relationship implications.", "user", "/api/v1/observability/token-fga-explain"],
  ]),
  getTool("yarn_overview", "Yarn ops overview: sessions, tokens, costs (GET /api/v1/yarn/overview).", "org_admin", SINCE_HOURS_SCHEMA, "/api/v1/yarn/overview", (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 720) })),
  getTool("yarn_intelligence", "Yarn intelligence rollup for the period (GET /api/v1/yarn/intelligence).", "org_admin", SINCE_HOURS_SCHEMA, "/api/v1/yarn/intelligence", (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 720) })),
  getTool(
    "yarn_sessions",
    "List Yarn IDE sessions (GET /api/v1/yarn/sessions).",
    "org_admin",
    {
      type: "object",
      properties: {
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 20, description: "Max 100" },
        active_since_hours: { type: "integer", default: 168, description: "Only sessions active in this window" },
      },
    },
    "/api/v1/yarn/sessions",
    (args) => ({
      page: asInt(args.page, 1, 1, 10_000),
      page_size: asInt(args.page_size, 20, 1, 100),
      active_since_hours: asInt(args.active_since_hours, 168, 1, 8760),
    }),
  ),
  {
    name: "yarn_session_detail",
    description: "Full detail for one Yarn session by session_key (GET /api/v1/yarn/sessions/{key}).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { session_key: { ...safeTextSchema(MAX_SESSION_KEY_CANDIDATE_CHARS, 1), description: "Yarn session key" } },
      required: ["session_key"],
    },
    invoke: async (ctx, args) => {
      const candidates = buildSessionKeyCandidates(args.session_key);
      if (candidates.length === 0) throw new Error("session_key required");

      let lastNotFound: Error | null = null;
      const exactCandidates = ctx.role === "platform_admin" || ctx.role === "admin"
        ? candidates.filter((candidate) => candidate.length >= 16)
        : candidates.slice(0, 1);
      for (const key of exactCandidates) {
        try {
          return await apiRequest(ctx, "GET", `/api/v1/yarn/sessions/${encodeURIComponent(key)}`);
        } catch (error) {
          if (!isHttpNotFoundError(error)) throw error;
          lastNotFound = error instanceof Error ? error : new Error(String(error));
        }
      }

      const resolvedKey =
        (ctx.role === "platform_admin" || ctx.role === "admin")
          ? await resolveSessionKeyFromRecentSessions(ctx, candidates)
          : null;
      if (resolvedKey) {
        return apiRequest(ctx, "GET", `/api/v1/yarn/sessions/${encodeURIComponent(resolvedKey)}`);
      }
      if (lastNotFound) {
        throw new AdminMcpToolError("session_not_found", 404, { attempted: exactCandidates.length });
      }
      throw new AdminMcpToolError("session_not_found", 404);
    },
  },
  {
    name: "yarn_current_work_packet",
    description: "Latest Synesis durable work packet for a Yarn session, including injection mode and packet text.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        session_key: {
          ...safeTextSchema(MAX_SESSION_KEY_CANDIDATE_CHARS, 1),
          description: "Yarn session key or copied session tail",
        },
      },
      required: ["session_key"],
    },
    invoke: async (ctx, args) => {
      const candidates = buildSessionKeyCandidates(args.session_key);
      if (candidates.length === 0) throw new Error("session_key required");

      let lastNotFound: Error | null = null;
      const exactCandidates = ctx.role === "platform_admin" || ctx.role === "admin"
        ? candidates.filter((candidate) => candidate.length >= 16)
        : candidates.slice(0, 1);
      for (const key of exactCandidates) {
        try {
          return await apiRequest(ctx, "GET", "/api/v1/yarn/sessions/current-work-packet", { session_key: key });
        } catch (error) {
          if (!isHttpNotFoundError(error)) throw error;
          lastNotFound = error instanceof Error ? error : new Error(String(error));
        }
      }

      const resolvedKey =
        (ctx.role === "platform_admin" || ctx.role === "admin")
          ? await resolveSessionKeyFromRecentSessions(ctx, exactCandidates)
          : null;
      if (resolvedKey) {
        return apiRequest(ctx, "GET", "/api/v1/yarn/sessions/current-work-packet", { session_key: resolvedKey });
      }
      if (lastNotFound) {
        throw new AdminMcpToolError("session_not_found", 404, { attempted: exactCandidates.length });
      }
      throw new AdminMcpToolError("session_not_found", 404);
    },
  },
  getTool(
    "yarn_performance",
    "Yarn latency and throughput buckets (GET /api/v1/yarn/performance).",
    "org_admin",
    {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        bucket_minutes: { type: "integer", default: 15, description: "Bucket size 5-60" },
      },
    },
    "/api/v1/yarn/performance",
    (args) => ({
      since_hours: asInt(args.since_hours, 24, 1, 720),
      bucket_minutes: asInt(args.bucket_minutes, 15, 5, 60),
    }),
  ),
  getTool(
    "yarn_events",
    "Yarn usage events and errors (GET /api/v1/yarn/events).",
    "org_admin",
    {
      type: "object",
      properties: {
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 50 },
        since_hours: { type: "integer", default: 24 },
        errors_only: { type: "boolean", default: false },
      },
    },
    "/api/v1/yarn/events",
    (args) => ({
      page: asInt(args.page, 1, 1, 10_000),
      page_size: asInt(args.page_size, 50, 1, 200),
      since_hours: asInt(args.since_hours, 24, 1, 720),
      errors_only: asBool(args.errors_only, false),
    }),
  ),
  getTool("yarn_safety_summary", "Yarn safety / policy events summary (GET /api/v1/yarn/safety-summary).", "org_admin", SINCE_HOURS_SCHEMA, "/api/v1/yarn/safety-summary", (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 720) })),
  getTool(
    "yarn_runtime_preferences",
    "Read the current user's advanced Coder runtime preferences.",
    "user",
    EMPTY_SCHEMA,
    "/api/v1/yarn/runtime-preferences",
  ),
  getTool(
    "yarn_diagnostics",
    "Fetch a Yarn diagnostics snapshot by request_id.",
    "org_admin",
    {
      type: "object",
      properties: { request_id: { ...IDENTIFIER_128_SCHEMA, description: "Yarn request id" } },
      required: ["request_id"],
    },
    (args) => `/api/v1/yarn/diagnostics/${encodeURIComponent(boundedString(args.request_id, 128))}`,
  ),
  ...noArgGetTools([
    ["yarn_health", "Direct health probe of the Yarn service.", "org_admin", "/api/v1/yarn/health"],
    ["yarn_runtime_telemetry", "Yarn runtime telemetry from /health/telemetry.", "org_admin", "/api/v1/yarn/runtime-telemetry"],
  ]),
  getTool(
    "yarn_reducer_telemetry_history",
    "Historical Yarn reducer telemetry snapshots and rollups.",
    "org_admin",
    {
      type: "object",
      properties: { since_hours: { type: "integer", default: 168 } },
    },
    "/api/v1/yarn/reducer-telemetry-history",
    (args) => ({ since_hours: asInt(args.since_hours, 168, 1, 720) }),
  ),
  ...noArgGetTools([
    ["yarn_language_packs", "Yarn language pack conformance matrix.", "org_admin", "/api/v1/yarn/language-packs"],
  ]),
  ...noArgPostTools([
    ["yarn_verify", "Run a quick Yarn health/model smoke verification.", "org_admin", "/api/v1/yarn/verify"],
  ]),
  getTool(
    "yarn_safety_events",
    "List Yarn safety/policy events.",
    "org_admin",
    {
      type: "object",
      properties: {
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 50 },
        since_hours: { type: "integer", default: 24 },
        event_kind: IDENTIFIER_64_SCHEMA,
      },
    },
    "/api/v1/yarn/safety-events",
    (args) => ({
      page: asInt(args.page, 1, 1, 10_000),
      page_size: asInt(args.page_size, 50, 1, 200),
      since_hours: asInt(args.since_hours, 24, 1, 720),
      event_kind: boundedString(args.event_kind, 64),
    }),
  ),
  ...noArgGetTools([
    ["yarn_diagnostics_recent", "Recent Yarn request diagnostics snapshots.", "org_admin", "/api/v1/yarn/diagnostics/recent"],
    ["yarn_optimization_watcher", "Summarize Yarn cache-shape stability, stage timing, and likely cache/prefix issues.", "org_admin", "/api/v1/yarn/optimization-watcher"],
  ]),
  postTool(
    "yarn_optimization_ai_brief",
    "Ask the configured admin assistant model to explain Yarn cache/prefix and pipeline watcher findings.",
    "org_admin",
    {
      type: "object",
      properties: {
        focus: {
          ...safeTextSchema(1000),
          description: "Optional operator focus, such as cache misses, tool schema churn, or slow stages.",
        },
      },
    },
    "/api/v1/yarn/optimization-watcher/assist",
    (args) => ({ focus: boundedString(args.focus, 1000) }),
  ),
  getTool(
    "yarn_user_usage",
    "Return Yarn usage for the current authenticated user.",
    "user",
    {
      type: "object",
      properties: { since_hours: { type: "integer", default: 720 } },
    },
    "/api/v1/yarn/user-usage",
    (args) => ({ since_hours: asInt(args.since_hours, 720, 1, 8760) }),
  ),
  {
    name: "yarn_transition_quality",
    description: "Transition quality calibration trends and alerts (GET /api/v1/yarn/transition-quality).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 168, description: "Lookback hours (1-720)" },
        bucket_minutes: { type: "integer", default: 60, description: "Bucket size 5-60" },
      },
    },
    invoke: async (ctx, args) => getTransitionQuality(ctx, args),
  },
  {
    name: "yarn_transition_events_tail",
    description:
      "Tail transition-quality events with risk extraction (GET /api/v1/yarn/transition-events).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_minutes: { type: "integer", default: 60, description: "Lookback minutes (1-1440)" },
        limit: { type: "integer", default: 100, description: "Max events (1-500)" },
        after_id: { type: "integer", default: 0, description: "Return only events with id > after_id" },
        risk_only: { type: "boolean", default: true, description: "Include only risk-bearing events" },
        include_metadata: { type: "boolean", default: false, description: "Include full metadata_json payloads" },
        event_kinds: {
          type: "array",
          items: { type: "string", enum: [...YARN_TRANSITION_EVENT_KINDS] },
          description: "Optional event-kind allowlist",
        },
      },
    },
    invoke: async (ctx, args) => getTransitionEvents(ctx, args),
  },
  {
    name: "yarn_transition_watch",
    description:
      "Watch transition quality over a short live window by polling trend and event tails.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        bucket_minutes: { type: "integer", default: 15 },
        events_since_minutes: { type: "integer", default: 30 },
        event_limit: { type: "integer", default: 120 },
        after_id: { type: "integer", default: 0 },
        risk_only: { type: "boolean", default: true },
        include_metadata: { type: "boolean", default: false },
        polls: { type: "integer", default: 4, description: "Number of polling iterations (1-12)" },
        interval_seconds: { type: "number", default: 5, description: "Pause between polls (1-30 sec)" },
      },
    },
    invoke: async (ctx, args) => {
      const polls = asInt(args.polls, 4, 1, 12);
      const intervalSeconds = asNumber(args.interval_seconds, 5, 1, 30);
      const totalWatchMs = Math.max(0, (polls - 1) * intervalSeconds * 1000);
      if (totalWatchMs > ctx.cfg.SYNESIS_ADMIN_MCP_WATCH_MAX_MS) {
        throw new AdminMcpToolError("watch_duration_exceeded", 400, {
          requested_ms: totalWatchMs,
          max_ms: ctx.cfg.SYNESIS_ADMIN_MCP_WATCH_MAX_MS,
        });
      }
      const watchKey = `${ctx.userId}:yarn_transition_watch`;
      const active = activeWatchByUser.get(watchKey) ?? 0;
      if (active >= ctx.cfg.SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER) {
        throw new AdminMcpToolError("watch_concurrency_exceeded", 429, { user: ctx.userId });
      }
      activeWatchByUser.set(watchKey, active + 1);
      try {
      const sinceHours = asInt(args.since_hours, 24, 1, 720);
      const bucketMinutes = asInt(args.bucket_minutes, 15, 5, 60);
      const eventsSinceMinutes = asInt(args.events_since_minutes, 30, 1, 1440);
      const eventLimit = asInt(args.event_limit, 120, 1, 300);
      const riskOnly = asBool(args.risk_only, true);
      const includeMetadata = asBool(args.include_metadata, false);
      let cursor = asInt(args.after_id, 0, 0, Number.MAX_SAFE_INTEGER);

      const frames: Array<Record<string, unknown>> = [];
      const collectedEvents: Array<Record<string, unknown>> = [];
      const seen = new Set<number>();
      let qualitySnapshot: Record<string, unknown> = {};
      const watchStartedAt = new Date().toISOString();

      for (let idx = 0; idx < polls; idx += 1) {
        const qualityRaw = await getTransitionQuality(ctx, {
          since_hours: sinceHours,
          bucket_minutes: bucketMinutes,
        });
        const quality =
          qualityRaw && typeof qualityRaw === "object" ? (qualityRaw as Record<string, unknown>) : {};
        qualitySnapshot = quality;
        const tailRaw = await getTransitionEvents(ctx, {
          since_minutes: eventsSinceMinutes,
          limit: eventLimit,
          after_id: cursor,
          risk_only: riskOnly,
          include_metadata: includeMetadata,
        });
        const tail = tailRaw && typeof tailRaw === "object" ? (tailRaw as Record<string, unknown>) : {};
        const nextAfter = asInt(tail.next_after_id, cursor, 0, Number.MAX_SAFE_INTEGER);
        cursor = Math.max(cursor, nextAfter);
        const events = Array.isArray(tail.events) ? (tail.events as Array<Record<string, unknown>>) : [];

        const newEvents: Array<Record<string, unknown>> = [];
        for (const ev of events) {
          const id = asInt(ev.id, 0, 0, Number.MAX_SAFE_INTEGER);
          if (id <= 0 || seen.has(id)) continue;
          seen.add(id);
          newEvents.push(ev);
          collectedEvents.push(ev);
        }

        const summary =
          quality.summary && typeof quality.summary === "object"
            ? (quality.summary as Record<string, unknown>)
            : {};

        frames.push({
          iteration: idx + 1,
          captured_at: new Date().toISOString(),
          quality_score_avg: summary.quality_score_avg,
          regressed_rate_avg: summary.regressed_rate_avg,
          reground_required_rate_avg: summary.reground_required_rate_avg,
          global_scope_coverage_avg: summary.global_scope_coverage_avg,
          risk_flags: Array.isArray(summary.risk_flags) ? summary.risk_flags : [],
          new_event_count: newEvents.length,
          next_after_id: cursor,
          new_events: newEvents,
        });

        if (idx < polls - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalSeconds * 1000));
        }
      }

      const finalSummary =
        qualitySnapshot.summary && typeof qualitySnapshot.summary === "object"
          ? (qualitySnapshot.summary as Record<string, unknown>)
          : {};
      const actions = Array.isArray(qualitySnapshot.actions) ? qualitySnapshot.actions : [];
      return {
        watch: {
          started_at: watchStartedAt,
          ended_at: new Date().toISOString(),
          polls,
          interval_seconds: intervalSeconds,
          since_hours: sinceHours,
          bucket_minutes: bucketMinutes,
          events_since_minutes: eventsSinceMinutes,
          event_limit: eventLimit,
          risk_only: riskOnly,
          next_after_id: cursor,
        },
        final_quality_summary: finalSummary,
        recommended_actions: actions,
        frames,
        events: collectedEvents.slice(-200),
      };
      } finally {
        const next = (activeWatchByUser.get(watchKey) ?? 1) - 1;
        if (next <= 0) activeWatchByUser.delete(watchKey);
        else activeWatchByUser.set(watchKey, next);
      }
    },
  },
  {
    name: "yarn_transition_incident_brief",
    description:
      "Generate an operator-ready transition-quality incident brief from trends + recent risk events.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        bucket_minutes: { type: "integer", default: 15 },
        events_since_minutes: { type: "integer", default: 180 },
        event_limit: { type: "integer", default: 150 },
      },
    },
    invoke: async (ctx, args) => {
      const sinceHours = asInt(args.since_hours, 24, 1, 720);
      const bucketMinutes = asInt(args.bucket_minutes, 15, 5, 60);
      const eventsSinceMinutes = asInt(args.events_since_minutes, 180, 1, 1440);
      const eventLimit = asInt(args.event_limit, 150, 1, 300);

      const qualityRaw = await getTransitionQuality(ctx, {
        since_hours: sinceHours,
        bucket_minutes: bucketMinutes,
      });
      const quality = qualityRaw && typeof qualityRaw === "object" ? (qualityRaw as Record<string, unknown>) : {};
      const tailRaw = await getTransitionEvents(ctx, {
        since_minutes: eventsSinceMinutes,
        limit: eventLimit,
        risk_only: true,
        include_metadata: false,
      });
      const tail = tailRaw && typeof tailRaw === "object" ? (tailRaw as Record<string, unknown>) : {};

      const summary =
        quality.summary && typeof quality.summary === "object"
          ? (quality.summary as Record<string, unknown>)
          : {};
      const riskFlags = Array.isArray(summary.risk_flags) ? summary.risk_flags.map((r) => asString(r)) : [];
      const topReasons = Array.isArray(quality.top_quality_reasons) ? quality.top_quality_reasons : [];
      const actions = Array.isArray(quality.actions) ? quality.actions : [];
      const events = Array.isArray(tail.events) ? (tail.events as Array<Record<string, unknown>>) : [];
      const latestEvent = events.length > 0 ? events[events.length - 1] : null;

      const findings: string[] = [];
      if (riskFlags.includes("high_regressed_rate")) {
        findings.push("Regressed transition rate is above warning threshold.");
      }
      if (riskFlags.includes("high_reground_required_rate")) {
        findings.push("Re-ground required rate is elevated; file-state confidence may be degrading.");
      }
      if (riskFlags.includes("low_global_scope_coverage")) {
        findings.push("Global scope coverage is low; check calibrator scope key stability.");
      }
      if (riskFlags.includes("low_quality_score_coverage")) {
        findings.push("Quality score coverage is low; verify state_transition_quality_score training signals are emitted.");
      }
      if (riskFlags.includes("missing_global_calibration_events")) {
        findings.push("No global calibration events observed in the active analysis window.");
      }
      if (findings.length === 0) {
        findings.push("No major window-level transition quality alerts are active.");
      }

      return {
        window: {
          since_hours: sinceHours,
          bucket_minutes: bucketMinutes,
          events_since_minutes: eventsSinceMinutes,
          event_limit: eventLimit,
        },
        quality_summary: summary,
        risk_flags: riskFlags,
        priority_findings: findings,
        top_quality_reasons: topReasons.slice(0, 6),
        recommended_actions: actions.slice(0, 6),
        event_tail: {
          count: asInt(tail.count, 0, 0, Number.MAX_SAFE_INTEGER),
          session_count: asInt(tail.session_count, 0, 0, Number.MAX_SAFE_INTEGER),
          request_count: asInt(tail.request_count, 0, 0, Number.MAX_SAFE_INTEGER),
          counts_by_kind:
            tail.counts_by_kind && typeof tail.counts_by_kind === "object" ? tail.counts_by_kind : {},
          latest_event: latestEvent,
          events: events.slice(-20),
        },
        next_best_questions: [
          "Which sessions dominate regressed transitions and what quality reasons repeat?",
          "Are global calibration events lagging behind local calibration in this period?",
          "Do risk spikes correlate with specific models or finish reasons?",
        ],
      };
    },
  },
  ...noArgGetTools([
    ["service_health", "Check health of all Synesis services.", "org_admin", "/api/v1/observability/health"],
    ["list_models", "List active model role assignments.", "org_admin", "/api/v1/models/roles"],
    ["model_topology", "Model registry topology and route graph.", "org_admin", "/api/v1/models/topology"],
    ["model_pipeline_services", "Operational health visibility for model-adjacent pipeline services.", "org_admin", "/api/v1/models/pipeline-services"],
    ["model_public_offerings", "Public model offerings catalog.", "org_admin", "/api/v1/models/public-offerings"],
    ["model_prompt_profiles", "Prompt profile library entries.", "org_admin", "/api/v1/models/prompts/profiles"],
    ["model_prompt_assignments", "Prompt profile assignments by service/role.", "org_admin", "/api/v1/models/prompts/assignments"],
    ["model_deployments", "Model deployment records and routing metadata.", "org_admin", "/api/v1/models/deployments"],
    ["model_active_costs", "Rate configuration for active model role assignments.", "org_admin", "/api/v1/models/costs/active"],
    ["model_costs", "Configured model cost estimates by role.", "org_admin", "/api/v1/models/costs"],
  ]),
  getTool(
    "model_costs_by_model",
    "Per-model cost breakdown from recent trace LLM calls.",
    "org_admin",
    DAYS_SCHEMA,
    "/api/v1/models/costs/by-model",
    (args) => ({ days: asInt(args.days, 7, 1, 90) }),
  ),
  getTool(
    "model_costs_by_role",
    "Per-role cost breakdown from recent trace LLM calls.",
    "org_admin",
    DAYS_SCHEMA,
    "/api/v1/models/costs/by-role",
    (args) => ({ days: asInt(args.days, 7, 1, 90) }),
  ),
  getTool(
    "model_costs_daily",
    "Daily cost trend from recent trace LLM calls.",
    "org_admin",
    DAYS_SCHEMA,
    "/api/v1/models/costs/daily",
    (args) => ({ days: asInt(args.days, 7, 1, 90) }),
  ),
  ...noArgGetTools([
    ["model_performance_summary", "Legacy Prometheus model performance summary.", "org_admin", "/api/v1/models/performance"],
  ]),
  getTool(
    "model_performance_detailed",
    "Trace-based per-model latency, token, cost, and cache-hit metrics.",
    "org_admin",
    DAYS_SCHEMA,
    "/api/v1/models/performance/detailed",
    (args) => ({ days: asInt(args.days, 7, 1, 90) }),
  ),
  getTool(
    "model_latency_trend",
    "Per-model daily latency trend.",
    "org_admin",
    { type: "object", properties: { days: { type: "integer", default: 14 } } },
    "/api/v1/models/performance/latency-trend",
    (args) => ({ days: asInt(args.days, 14, 1, 90) }),
  ),
  getTool(
    "model_performance_by_role",
    "Trace-based model performance grouped by role.",
    "org_admin",
    DAYS_SCHEMA,
    "/api/v1/models/performance/by-role",
    (args) => ({ days: asInt(args.days, 7, 1, 90) }),
  ),
  postTool(
    "model_effort_recommend",
    "Preview planner effort recommendation for a prompt.",
    "org_admin",
    {
      type: "object",
      properties: {
        prompt: { ...safeTextSchema(12000, 1), description: "Prompt to evaluate" },
        effort_mode: { type: "string", enum: [...MODEL_EFFORT_MODES] },
        include_frame: { type: "boolean", default: true },
        operational_health: { type: "number" },
      },
      required: ["prompt"],
    },
    "/api/v1/models/effort/recommend",
    (args) => ({
      prompt: boundedString(args.prompt, 12000),
      effort_mode: boundedString(args.effort_mode, 64),
      include_frame: args.include_frame === undefined ? true : asBool(args.include_frame, true),
      operational_health: typeof args.operational_health === "number" && Number.isFinite(args.operational_health)
        ? args.operational_health
        : undefined,
    }),
  ),
  ...noArgGetTools([
    ["model_policies", "Active model policies grouped by role.", "org_admin", "/api/v1/models/policies"],
  ]),
  getTool(
    "model_role_policies",
    "Ordered policy rules for one model role.",
    "org_admin",
    {
      type: "object",
      properties: { role: { ...MODEL_ROLE_SCHEMA, description: "Model role" } },
      required: ["role"],
    },
    (args) => `/api/v1/models/policies/${encodeURIComponent(boundedString(args.role, 128))}`,
  ),
  getTool(
    "model_role_history",
    "Change history for a model role assignment.",
    "org_admin",
    {
      type: "object",
      properties: { role: { ...MODEL_ROLE_SCHEMA, description: "Model role" } },
      required: ["role"],
    },
    (args) => `/api/v1/models/roles/${encodeURIComponent(boundedString(args.role, 128))}/history`,
  ),
  ...noArgGetTools([
    ["provider_catalog", "Provider catalog and canonical model roles.", "user", "/api/v1/providers/catalog"],
    ["provider_discovery_supported", "Provider keys that support model discovery.", "org_admin", "/api/v1/providers/discovery/supported"],
  ]),
  getTool(
    "provider_discovery_models",
    "Discover available models for a provider.",
    "org_admin",
    {
      type: "object",
      properties: {
        provider_key: IDENTIFIER_64_SCHEMA,
        bypass_cache: { type: "boolean", default: false },
      },
      required: ["provider_key"],
    },
    (args) => `/api/v1/providers/discovery/${encodeURIComponent(boundedString(args.provider_key, 64))}/models`,
    (args) => ({ bypass_cache: asBool(args.bypass_cache, false) }),
  ),
  getTool(
    "provider_discovery_defaults",
    "Recommended route defaults for a provider/model pair.",
    "org_admin",
    {
      type: "object",
      properties: {
        provider_key: IDENTIFIER_64_SCHEMA,
        model_id: MODEL_ID_256_SCHEMA,
        context_window: { type: "integer" },
      },
      required: ["provider_key"],
    },
    (args) => `/api/v1/providers/discovery/${encodeURIComponent(boundedString(args.provider_key, 64))}/defaults`,
    (args) => ({
      model_id: boundedString(args.model_id, 256),
      context_window: optionalInt(args.context_window, 0, 1, 10_000_000),
    }),
  ),
  postTool(
    "provider_discovery_validate",
    "Validate a model ID for a provider and return hints.",
    "org_admin",
    {
      type: "object",
      properties: {
        provider: IDENTIFIER_64_SCHEMA,
        model: MODEL_ID_256_SCHEMA,
      },
      required: ["provider", "model"],
    },
    "/api/v1/providers/discovery/validate",
    (args) => ({ provider: boundedString(args.provider, 64), model: boundedString(args.model, 256) }),
  ),
  ...noArgGetTools([
    ["provider_keys_status", "Provider API key names and configured status; never returns secret values.", "platform_admin", "/api/v1/providers/keys"],
    ["provider_consumers_restart_status", "Rollout status for provider key consumer deployments.", "platform_admin", "/api/v1/providers/consumers/restart-status"],
    ["provider_governance_list", "Provider governance overlay, enablement, defaults, policies, and key status.", "org_admin", "/api/v1/provider-governance"],
  ]),
  getTool(
    "provider_governance_detail",
    "Single provider governance config and catalog overlay.",
    "org_admin",
    {
      type: "object",
      properties: { provider_key: IDENTIFIER_64_SCHEMA },
      required: ["provider_key"],
    },
    (args) => `/api/v1/provider-governance/${encodeURIComponent(boundedString(args.provider_key, 64))}`,
  ),
  getTool(
    "governance_effective",
    "Merged effective governance rules for an org/scope/category/language.",
    "user",
    {
      type: "object",
      properties: {
        org_id: SAFE_TEXT_256_SCHEMA,
        scope: { type: "string", enum: [...GOVERNANCE_SCOPES] },
        category: { type: "string", enum: [...GOVERNANCE_CATEGORIES] },
        language: SAFE_TEXT_64_SCHEMA,
      },
    },
    "/api/v1/governance/effective",
    (args) => ({
      org_id: boundedString(args.org_id, 128),
      scope: boundedString(args.scope, 64),
      category: boundedString(args.category, 64),
      language: boundedString(args.language, 32),
    }),
  ),
  getTool(
    "capability_matrix_effective",
    "Effective capability matrix and supported optimization capabilities.",
    "user",
    {
      type: "object",
      properties: { org_id: SAFE_TEXT_256_SCHEMA },
    },
    "/api/v1/governance/capability-matrix/effective",
    (args) => ({ org_id: boundedString(args.org_id, 128) }),
  ),
  ...noArgGetTools([
    ["governance_summary", "Governance dashboard summary and recent constitution changes.", "org_admin", "/api/v1/governance/summary"],
  ]),
  getTool(
    "audit_events",
    "Newest-first admin audit event stream. Platform admin only.",
    "platform_admin",
    {
      type: "object",
      properties: {
        limit: { type: "integer", default: 100 },
        before_id: { type: "integer" },
      },
    },
    "/api/v1/audit/events",
    (args) => ({ limit: asInt(args.limit, 100, 1, 500), before_id: optionalInt(args.before_id, 0, 1, Number.MAX_SAFE_INTEGER) }),
  ),
  getTool(
    "security_events",
    "List security guardrail events scoped by org observability access.",
    "org_admin",
    {
      type: "object",
      properties: {
        limit: { type: "integer", default: 100 },
        before_id: { type: "integer" },
        severity: { type: "string", enum: [...SECURITY_EVENT_SEVERITIES] },
        event_type: { type: "string", enum: [...SECURITY_EVENT_TYPES] },
        service: { type: "string", enum: [...SECURITY_EVENT_SERVICES] },
        resolved: { type: "boolean" },
        since_hours: { type: "integer" },
      },
    },
    "/api/v1/security/events",
    (args) => ({
      limit: asInt(args.limit, 100, 1, 500),
      before_id: optionalInt(args.before_id, 0, 1, Number.MAX_SAFE_INTEGER),
      severity: boundedString(args.severity, 64),
      event_type: boundedString(args.event_type, 128),
      service: boundedString(args.service, 64),
      resolved: optionalBool(args.resolved),
      since_hours: optionalInt(args.since_hours, 24, 1, 8760),
    }),
  ),
  getTool(
    "security_summary",
    "Security guardrail summary for a lookback window.",
    "org_admin",
    SINCE_HOURS_SCHEMA,
    "/api/v1/security/summary",
    (args) => ({ since_hours: asInt(args.since_hours, 24, 1, 8760) }),
  ),
  ...noArgGetTools([
    ["web_search_stats", "Aggregate web-search stats from Prometheus or Postgres fallback.", "org_admin", "/api/v1/integrations/web-search"],
  ]),
  getTool(
    "web_search_log",
    "Search web-search event logs with filters.",
    "org_admin",
    {
      type: "object",
      properties: {
        domain: safeTextSchema(256),
        outcome: { type: "string", enum: [...WEB_SEARCH_OUTCOMES] },
        source_surface: { type: "string", enum: [...WEB_SEARCH_SOURCE_SURFACES] },
        org_id: SAFE_TEXT_256_SCHEMA,
        user_id: SAFE_TEXT_256_SCHEMA,
        session_key: safeTextSchema(256),
        request_id: IDENTIFIER_128_SCHEMA,
        trace_id: IDENTIFIER_128_SCHEMA,
        tool_name: IDENTIFIER_128_SCHEMA,
        engine: IDENTIFIER_64_SCHEMA,
        q: safeTextSchema(256),
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 30 },
      },
    },
    "/api/v1/integrations/web-search/log",
    (args) => ({
      domain: boundedString(args.domain, 256),
      outcome: boundedString(args.outcome, 32),
      source_surface: boundedString(args.source_surface, 64),
      org_id: boundedString(args.org_id, 128),
      user_id: boundedString(args.user_id, 128),
      session_key: boundedString(args.session_key, 256),
      request_id: boundedString(args.request_id, 128),
      trace_id: boundedString(args.trace_id, 128),
      tool_name: boundedString(args.tool_name, 128),
      engine: boundedString(args.engine, 64),
      q: boundedString(args.q, 256),
      page: asInt(args.page, 1, 1, 10_000),
      page_size: asInt(args.page_size, 30, 1, 100),
    }),
  ),
  getTool(
    "web_search_domain_summary",
    "Domain-level web-search usage and error summary.",
    "org_admin",
    { type: "object", properties: { limit: { type: "integer", default: 50 } } },
    "/api/v1/integrations/web-search/log/domains",
    (args) => ({ limit: asInt(args.limit, 50, 1, 200) }),
  ),
  ...noArgGetTools([
    ["web_search_policies", "List web-search URL HITL policies.", "org_admin", "/api/v1/integrations/web-search/policies"],
    ["cache_metrics", "Prefix cache hit rates, token savings, and session stats.", "org_admin", "/api/v1/observability/cache"],
    ["circuit_breakers", "Current circuit breaker states for LLM, web search, and infra.", "org_admin", "/api/v1/observability/circuit-breakers"],
    ["knowledge_gap_stats", "RAG corpus knowledge gap statistics.", "org_admin", "/api/v1/observability/knowledge-gaps/stats"],
  ]),
  {
    name: "refresh_model_routes",
    description: "Report the direct model route source of truth. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "POST", "/api/v1/models/reconcile"),
  },
  {
    name: "purge_trivial_traces",
    description: "Dry-run count or delete traces below a token threshold. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        min_tokens: { type: "integer", default: 50 },
        dry_run: { type: "boolean", default: true },
      },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "POST", "/api/v1/traces/purge-trivial", {
        min_tokens: asInt(args.min_tokens, 50, 1, 1_000_000),
        dry_run: asBool(args.dry_run, true),
      }),
  },
  getTool(
    "ingestion_list_items",
    "List ingestion queue items with filters. Platform admin only.",
    "platform_admin",
    {
      type: "object",
      properties: {
        status: { type: "string", enum: [...INGESTION_ITEM_STATUSES], description: "Filter by ingestion status" },
        handler: { type: "string", enum: [...INGESTION_HANDLERS], description: "Filter by handler type" },
        limit: { type: "integer", default: 20, description: "Max results" },
      },
    },
    "/api/v1/ingestion/items",
    (args) => ({
      status: boundedString(args.status, 64),
      handler: boundedString(args.handler, 64),
      page: 1,
      page_size: asInt(args.limit, 20, 1, 100),
    }),
  ),
  patchTool(
    "ingestion_patch_item",
    "Edit an ingestion item's metadata or status. Platform admin only.",
    "platform_admin",
    {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "The item ID" },
        title: safeTextSchema(512),
        handler: { type: "string", enum: [...INGESTION_HANDLERS] },
        domain: safeTextSchema(128),
        tags: { type: "array", items: safeTextSchema(64) },
        priority: { type: "integer" },
        status: { type: "string", enum: [...INGESTION_ITEM_STATUSES], description: "Admin-driven status transition" },
        config: INGESTION_CONFIG_SCHEMA,
      },
      required: ["item_id"],
    },
    (args) => {
      const itemId = asInt(args.item_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (itemId <= 0) throw new Error("item_id required");
      return `/api/v1/ingestion/items/${itemId}`;
    },
    (args) => {
      const patch: Record<string, unknown> = {};
      for (const key of ["title", "handler", "domain", "tags", "priority", "status", "config"]) {
        if (args[key] === undefined) continue;
        patch[key] = key === "config" ? sanitizeIngestionConfig(args[key]) : args[key];
      }
      return patch;
    },
  ),
  postTool(
    "ingestion_discover_url",
    "Run discovery on a URL to get a suggested ingestion config. Platform admin only.",
    "platform_admin",
    {
      type: "object",
      properties: {
        url: { ...INGESTION_PUBLIC_URL_SCHEMA, description: "URL to analyse" },
        hint_tags: {
          type: "array",
          items: { type: "string", enum: [...INGESTION_DISCOVERY_HINTS] },
          description: "Known discovery hints",
        },
        use_llm: { type: "boolean", default: false, description: "Use LLM for enrichment" },
      },
      required: ["url"],
    },
    "/api/v1/ingestion/discover",
    (args) => {
      const url = boundedString(args.url, 2048);
      if (!url) throw new Error("url required");
      return {
        url,
        hints: ingestionDiscoveryHints(args.hint_tags),
        use_llm: asBool(args.use_llm, false),
      };
    },
  ),
  {
    name: "ingestion_retry_item",
    description: "Retry a failed or dead_letter ingestion item. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "The item ID" },
        reset_retries: { type: "boolean", default: false, description: "Reset retry counter" },
      },
      required: ["item_id"],
    },
    invoke: async (ctx, args) => {
      const itemId = asInt(args.item_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (itemId <= 0) throw new Error("item_id required");
      return apiRequest(
        ctx,
        "POST",
        `/api/v1/ingestion/items/${itemId}/retry`,
        { reset_retries: asBool(args.reset_retries, false) },
      );
    },
  },
  {
    name: "ingestion_requeue_item",
    description: "Re-queue any ingestion item back to pending. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "The item ID" },
        reset_retries: { type: "boolean", default: false },
      },
      required: ["item_id"],
    },
    invoke: async (ctx, args) => {
      const itemId = asInt(args.item_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (itemId <= 0) throw new Error("item_id required");
      return apiRequest(
        ctx,
        "POST",
        `/api/v1/ingestion/items/${itemId}/requeue`,
        { reset_retries: asBool(args.reset_retries, false) },
      );
    },
  },
];

export function roleRank(role: string | undefined): number {
  if (!role) return 0;
  const key = (role in ROLE_RANK ? role : role.toLowerCase()) as AdminRole;
  return ROLE_RANK[key] ?? 0;
}

export function isOrgAdminOrHigher(role: string | undefined): boolean {
  return roleRank(role) >= ROLE_RANK.org_admin;
}

export function visibleToolDescriptorsForRole(role: string | undefined): AdminToolDescriptor[] {
  const rank = roleRank(role);
  return TOOL_DEFINITIONS
    .filter((tool) => rank >= roleRank(tool.min_role))
    .map((tool) => ({ ...tool, inputSchema: strictInputSchema(tool.inputSchema) }));
}

export function openAIFunctionToolsForRole(
  role: string | undefined,
  allowedToolNames?: Set<string>,
): Array<Record<string, unknown>> {
  const visible = visibleToolDescriptorsForRole(role);
  return visible
    .filter((tool) => (allowedToolNames ? allowedToolNames.has(tool.name) : true))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

export async function invokeTool(
  ctx: ToolContext,
  role: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (roleRank(role) < roleRank(tool.min_role)) {
    throw new Error(`Tool '${name}' requires ${tool.min_role} role`);
  }
  return tool.invoke(ctx, validateToolArgs(tool, args));
}
