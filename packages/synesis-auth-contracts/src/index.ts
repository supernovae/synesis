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
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  return normalizeTokenScopes(raw
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean));
}

export function normalizeTokenScopes(value: readonly string[] | undefined, fallback: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const raw of value ?? fallback) {
    const scope = String(raw).trim();
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

export function hasScopePrefix(scopes: readonly string[] | undefined, prefixes: readonly string[]): boolean {
  const normalizedPrefixes = prefixes.map((prefix) => prefix.trim().toLowerCase()).filter(Boolean);
  if (normalizedPrefixes.length === 0) return false;
  return (scopes ?? []).some((scope) => {
    const normalizedScope = scope.trim().toLowerCase();
    return normalizedPrefixes.some((prefix) => normalizedScope === prefix || normalizedScope.startsWith(prefix));
  });
}

export function hasAnyScope(scopes: readonly string[] | undefined, allowedScopes: readonly string[]): boolean {
  const allowed = new Set(allowedScopes.map((scope) => scope.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return false;
  return (scopes ?? []).some((scope) => allowed.has(scope.trim().toLowerCase()));
}

export function firstHeaderValue(headers: HeaderMap, key: string): string {
  const value = headers[key.toLowerCase()] ?? headers[key];
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
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
  const userId = firstHeaderValue(headers, "x-openwebui-user-id") || "forwarded-user";
  const userEmail = firstHeaderValue(headers, "x-openwebui-user-email");
  const orgId = firstHeaderValue(headers, "x-synesis-org-id");
  const tenantIds = parseCsvScopes(headers["x-synesis-tenant-ids"]);
  const aclGroups = parseCsvScopes(headers["x-synesis-acl-groups"]);
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
  return {
    userId: forwarded.userId,
    userEmail: forwarded.userEmail,
    orgId: forwarded.orgId,
    tenantIds: forwarded.tenantIds,
    aclGroups: forwarded.aclGroups,
    role: "user",
    tokenScopes: normalizeTokenScopes(forwarded.tokenScopes, fallbackScopes),
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
