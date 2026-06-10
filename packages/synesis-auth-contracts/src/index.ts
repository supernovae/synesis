import crypto from "node:crypto";

export const SYNESIS_AUTH_METHODS = [
  "anonymous",
  "bearer",
  "pat",
  "oidc",
  "internal",
  "internal_service",
] as const;

export type SynesisAuthMethod = typeof SYNESIS_AUTH_METHODS[number];

export interface SynesisPrincipalBase {
  userId: string;
  orgId: string;
  tenantIds: string[];
  role: string;
  tokenScopes: string[];
  userEmail?: string;
  aclGroups?: string[];
  displayName?: string;
  authKeyId?: string;
  authKeyName?: string;
  authKeyPrefix?: string;
  trustedForwardedIdentity?: boolean;
}

export interface SynesisPrincipal extends SynesisPrincipalBase {
  authMethod: SynesisAuthMethod;
}

export interface SynesisForwardedIdentity {
  present: boolean;
  userId: string;
  userEmail: string;
  orgId: string;
  tenantIds: string[];
  aclGroups: string[];
  tokenScopes: string[];
}

export type HeaderMap = Record<string, string | string[] | undefined>;

const SECURITY_ID_RE = /^[^\s,]{1,256}$/;
const ORG_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const TENANT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ACL_GROUP_RE = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const TOKEN_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9:_.*-]{0,127}$/;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const CACHE_KEY_PART_RE = /^[A-Za-z0-9_.@-]+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const CODER_ACCESS_SCOPES = new Set([
  "coder",
  "coder:readonly",
  "coder:readwrite",
  "coder:execute",
  "coder:opaque",
  "model:readonly",
  "model:readwrite",
  "chat",
  "chat:readonly",
  "chat:readwrite",
]);

const MODEL_READ_SCOPES = new Set([
  "model",
  "model:readonly",
  "model:readwrite",
  "coder",
  "coder:readonly",
  "coder:readwrite",
  "coder:execute",
  "chat",
  "chat:readonly",
  "chat:readwrite",
]);

const MCP_ACCESS_SCOPES = new Set([
  "coder",
  "coder:readonly",
  "coder:readwrite",
  "coder:execute",
  "mcp:invoke",
  "mcp:tool:*",
]);

function boundedHeaderString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > maxLength) throw new Error("invalid_forwarded_identity_header");
  return text;
}

function sha256Hex(value: string, chars: number): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, chars);
}

export function boundedSecurityString(value: unknown, maxLength: number, fieldName = "security_value"): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`invalid_${fieldName}`);
  return text;
}

export function canonicalSecurityId(value: unknown, fieldName = "security_id"): string {
  const text = boundedSecurityString(value, 256, fieldName);
  if (!text || !SECURITY_ID_RE.test(text)) throw new Error(`invalid_${fieldName}`);
  return text;
}

export function optionalCanonicalOrgId(value: unknown): string {
  const text = boundedSecurityString(value, 256, "org_id");
  if (!text) return "";
  if (!ORG_ID_RE.test(text)) throw new Error("invalid_org_id");
  return text;
}

export function normalizeSecurityStringArray(
  value: unknown,
  fieldName: string,
  pattern: RegExp,
  maxItems: number,
  normalize: (item: string) => string = (item) => item,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`invalid_${fieldName}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error(`invalid_${fieldName}`);
    const item = normalize(raw.trim());
    if (!item) continue;
    if (!pattern.test(item)) throw new Error(`invalid_${fieldName}`);
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length > maxItems) throw new Error(`invalid_${fieldName}`);
  }
  return out;
}

export function normalizeTenantIds(value: unknown): string[] {
  return normalizeSecurityStringArray(value, "tenant_ids", TENANT_ID_RE, 50);
}

export function cacheKeyPart(
  value: unknown,
  fallback: string,
  options: { maxEncodedLength?: number; hashChars?: number; allowedPattern?: RegExp } = {},
): string {
  const maxEncodedLength = options.maxEncodedLength ?? 160;
  const hashChars = options.hashChars ?? 32;
  const allowedPattern = options.allowedPattern ?? CACHE_KEY_PART_RE;
  const fallbackPart = fallback.trim() || "unknown";
  const raw = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  if (!raw) return fallbackPart;
  if (!allowedPattern.test(raw)) return `${fallbackPart}-${sha256Hex(raw, hashChars)}`;
  const encoded = encodeURIComponent(raw);
  if (encoded.length <= maxEncodedLength) return encoded;
  return `${fallbackPart}-${sha256Hex(raw, hashChars)}`;
}

export function normalizeRequestId(value: unknown, fallback: string, prefix = "request"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw && REQUEST_ID_RE.test(raw)) return raw;
  const safeFallback = typeof fallback === "string" ? fallback.trim() : "";
  if (safeFallback && REQUEST_ID_RE.test(safeFallback)) return safeFallback;
  return `${prefix}-${sha256Hex(`${raw}:${safeFallback}`, 32)}`;
}

function requireHeaderPattern(value: string, pattern: RegExp, fieldName: string): string {
  if (!value || !pattern.test(value)) throw new Error(`invalid_${fieldName}`);
  return value;
}

function optionalHeaderPattern(value: string, pattern: RegExp, fieldName: string): string {
  if (!value) return "";
  return requireHeaderPattern(value, pattern, fieldName);
}

function parseBoundedCsvList(
  value: string | string[] | undefined,
  fieldName: string,
  pattern: RegExp,
  maxItems: number,
  normalize: (item: string) => string = (item) => item,
): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const item = normalize(part.trim());
    if (!item) continue;
    if (!pattern.test(item)) throw new Error(`invalid_${fieldName}`);
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length > maxItems) throw new Error(`invalid_${fieldName}`);
  }
  return out;
}

export function extractBearerToken(authorizationHeader: string | undefined): string {
  const raw = authorizationHeader ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

export function constantTimeStringMatch(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function constantTimeBearerMatch(authorizationHeader: string | undefined, expectedToken: string | undefined): boolean {
  const expected = (expectedToken ?? "").trim();
  if (!expected) return false;
  return constantTimeStringMatch(extractBearerToken(authorizationHeader), expected);
}

export function hashPatToken(token: string, pepper: string): string {
  if (pepper) {
    return crypto.createHmac("sha256", pepper).update(token).digest("hex");
  }
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function stableOpaqueBearerUserId(token: string): string {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
  return `bearer-${tokenHash}`;
}

export type PatPepperRequirement = {
  patValidationEnabled: boolean;
  pepper: string;
  requirePatPepper: boolean;
  serviceName: string;
};

export function validatePatPepperRequirement(requirement: PatPepperRequirement): void {
  if (
    requirement.patValidationEnabled
    && requirement.requirePatPepper
    && !requirement.pepper.trim()
  ) {
    throw new Error(`${requirement.serviceName}: SYNESIS_PAT_PEPPER is required when PAT validation is enabled`);
  }
}

export function parseCsvScopes(value: string | string[] | undefined): string[] {
  return parseBoundedCsvList(value, "token_scopes", TOKEN_SCOPE_RE, 100, (scope) => scope.toLowerCase());
}

export function normalizeTokenScopes(value: readonly string[] | undefined, fallback: readonly string[] = []): string[] {
  return parseBoundedCsvList([...(value ?? fallback)], "token_scopes", TOKEN_SCOPE_RE, 100, (scope) => scope.toLowerCase());
}

export function hasAnyScope(scopes: readonly string[] | undefined, allowedScopes: readonly string[]): boolean {
  const allowed = new Set(allowedScopes.map((scope) => scope.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return false;
  return (scopes ?? []).some((scope) => allowed.has(scope.trim().toLowerCase()));
}

function hasExactScope(scopes: readonly string[] | undefined, allowed: ReadonlySet<string>): boolean {
  return (scopes ?? []).some((scope) => allowed.has(scope.trim().toLowerCase()));
}

export function hasCoderAccessScope(scopes: readonly string[] | undefined): boolean {
  return hasExactScope(scopes, CODER_ACCESS_SCOPES);
}

export function hasModelReadScope(scopes: readonly string[] | undefined): boolean {
  return hasExactScope(scopes, MODEL_READ_SCOPES);
}

export function hasMcpInvokeScope(scopes: readonly string[] | undefined): boolean {
  return hasExactScope(scopes, MCP_ACCESS_SCOPES);
}

export function firstHeaderValue(headers: HeaderMap, key: string): string {
  const value = headers[key.toLowerCase()] ?? headers[key];
  if (Array.isArray(value)) return boundedHeaderString(value[0] ?? "", 512);
  return boundedHeaderString(value ?? "", 512);
}

export function hasForwardedIdentityHeaders(headers: HeaderMap): boolean {
  return [
    "x-openwebui-user-id",
    "x-openwebui-user-email",
    "x-synesis-org-id",
    "x-synesis-tenant-ids",
    "x-synesis-acl-groups",
  ].some((key) => firstHeaderValue(headers, key).length > 0);
}

export function parseForwardedIdentityHeaders(headers: HeaderMap): SynesisForwardedIdentity {
  const userId = optionalHeaderPattern(firstHeaderValue(headers, "x-openwebui-user-id"), SECURITY_ID_RE, "forwarded_user_id")
    || "forwarded-user";
  const userEmail = optionalHeaderPattern(firstHeaderValue(headers, "x-openwebui-user-email"), EMAIL_RE, "forwarded_user_email");
  const orgId = optionalHeaderPattern(firstHeaderValue(headers, "x-synesis-org-id"), ORG_ID_RE, "forwarded_org_id");
  const tenantIds = parseBoundedCsvList(headers["x-synesis-tenant-ids"], "forwarded_tenant_ids", TENANT_ID_RE, 50);
  const aclGroups = parseBoundedCsvList(headers["x-synesis-acl-groups"], "forwarded_acl_groups", ACL_GROUP_RE, 100);
  const tokenScopes = parseCsvScopes(headers["x-synesis-token-scopes"]);
  return {
    present: hasForwardedIdentityHeaders(headers),
    userId,
    userEmail,
    orgId,
    tenantIds,
    aclGroups,
    tokenScopes,
  };
}

export function buildForwardedIdentityPrincipal(
  forwarded: SynesisForwardedIdentity,
  fallbackScopes: readonly string[] = ["model:readonly"],
): SynesisPrincipal {
  const scopes = forwarded.tokenScopes.length > 0 ? forwarded.tokenScopes : fallbackScopes;
  return {
    userId: forwarded.userId,
    userEmail: forwarded.userEmail,
    orgId: forwarded.orgId,
    tenantIds: forwarded.tenantIds,
    aclGroups: forwarded.aclGroups,
    role: "user",
    tokenScopes: normalizeTokenScopes(scopes, fallbackScopes),
    authMethod: "internal_service",
    authKeyId: "internal-service",
    authKeyName: "Internal service",
    authKeyPrefix: "internal",
    trustedForwardedIdentity: true,
  };
}

export function authDiagnostics(principal: SynesisPrincipalBase & { authMethod?: SynesisAuthMethod }): Record<string, unknown> {
  return {
    user_id: principal.userId,
    org_id: principal.orgId,
    tenant_count: principal.tenantIds.length,
    role: principal.role,
    auth_method: principal.authMethod ?? "anonymous",
    scope_count: principal.tokenScopes.length,
    trusted_forwarded_identity: Boolean(principal.trustedForwardedIdentity),
    ...(principal.authKeyId ? { auth_key_id: principal.authKeyId } : {}),
    ...(principal.authKeyPrefix ? { auth_key_prefix: principal.authKeyPrefix } : {}),
  };
}
