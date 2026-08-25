import { Pool } from "pg";
import {
  boundedSecurityString,
  canonicalSecurityId,
  extractBearerToken,
  hasMcpInvokeScope,
  hashPatToken,
  normalizeSecurityStringArray,
  normalizeTenantIds,
  optionalCanonicalOrgId,
  type SynesisPrincipalBase,
} from "@synesis/auth-contracts";
import {
  createOidcVerifierFromEnv,
  OidcAuthError,
  type OidcTokenVerifier,
  type OidcVerifiedPrincipal,
} from "@synesis/oidc-auth";
import type { McpTsConfig } from "./config.js";
import type { SynesisMcpAuth } from "@synesis/mcp-tools";

export interface PatUser extends SynesisPrincipalBase {
  authMethod?: "pat" | "oidc" | "internal";
}

export type McpPrincipalRole = "readonly" | "user" | "org_admin" | "platform_admin" | "admin" | "service";

const MCP_PRINCIPAL_ROLES = new Set<McpPrincipalRole>([
  "readonly",
  "user",
  "org_admin",
  "platform_admin",
  "admin",
  "service",
]);
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9:_.*-]{0,127}$/;

function boundedDisplayString(value: unknown, maxLength: number): string {
  return boundedSecurityString(value, maxLength, "display_value");
}

function normalizeRole(value: unknown): McpPrincipalRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return MCP_PRINCIPAL_ROLES.has(role as McpPrincipalRole) ? role as McpPrincipalRole : null;
}

function normalizeTokenScopeList(value: unknown, fallback: readonly string[] = []): string[] {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw new Error("invalid_token_scopes");
  }
  const source = [...fallback, ...(value ?? [])];
  return normalizeSecurityStringArray(source, "token_scopes", SCOPE_RE, 100, (scope) => scope.toLowerCase());
}

export class McpAuthResolver {
  private readonly pool: Pool | null;
  private readonly pepper: string;
  private readonly oidcVerifier: OidcTokenVerifier | null;

  constructor(config: McpTsConfig) {
    this.pool = config.SYNESIS_ADMIN_DB_URL
      ? new Pool({
          connectionString: config.SYNESIS_ADMIN_DB_URL,
          max: config.SYNESIS_DB_POOL_MAX,
          idleTimeoutMillis: config.SYNESIS_DB_POOL_IDLE_MS,
          connectionTimeoutMillis: config.SYNESIS_DB_POOL_CONN_TIMEOUT_MS,
      })
      : null;
    this.pepper = config.SYNESIS_PAT_PEPPER;
    this.oidcVerifier = createOidcVerifierFromEnv({
      issuerUrl: config.SYNESIS_OIDC_ISSUER_URL,
      internalIssuerUrl: config.SYNESIS_OIDC_INTERNAL_ISSUER_URL,
      allowedClientIds: config.SYNESIS_OIDC_ALLOWED_CLIENT_IDS,
      requiredRoles: config.SYNESIS_OIDC_REQUIRED_ROLES,
      jwksCacheTtlMs: config.SYNESIS_OIDC_JWKS_CACHE_TTL_MS,
    });
    if (this.pool && !this.pepper) {
      console.warn("[auth] SYNESIS_PAT_PEPPER is empty — PAT hashing uses plain SHA-256 instead of HMAC. Set a pepper for production deployments.");
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  extractBearer(authorizationHeader: string | undefined): string {
    const token = extractBearerToken(authorizationHeader);
    if (!token) throw new Error("Missing Bearer token");
    return token;
  }

  requireCoderScope(user: PatUser): void {
    const scopes = user.tokenScopes;
    if (!scopes || scopes.length === 0) {
      throw new Error("Insufficient scope for MCP access");
    }
    if (hasMcpInvokeScope(scopes)) {
      return;
    }
    throw new Error("Insufficient scope for MCP access");
  }

  async resolvePat(token: string): Promise<PatUser | null> {
    if (!this.pool) return null;
    const tokenHash = this.hashPat(token);
    const result = await this.pool.query(
      `
      SELECT user_id, org_id, tenant_ids, role, scopes, username
      FROM personal_access_tokens
      WHERE token_hash = $1
        AND revoked = false
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
      `,
      [tokenHash],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as {
      user_id: string;
      org_id: string | null;
      tenant_ids: string[] | null;
      role: string | null;
      scopes: string[] | null;
      username: string | null;
    };
    let userId: string;
    let orgId: string;
    let tenantIds: string[];
    let role: McpPrincipalRole;
    let tokenScopes: string[];
    try {
      userId = canonicalSecurityId(row.user_id, "user_id");
      orgId = optionalCanonicalOrgId(row.org_id);
      tenantIds = normalizeTenantIds(row.tenant_ids);
      const parsedRole = normalizeRole(row.role ?? "user");
      if (!parsedRole || parsedRole === "service") return null;
      role = parsedRole;
      tokenScopes = normalizeTokenScopeList(row.scopes);
    } catch {
      return null;
    }
    if (tenantIds.length > 0 && !orgId) return null;

    void this.pool
      .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE token_hash = $1", [tokenHash])
      .catch((err) => { console.warn("[auth] PAT last_used update failed:", (err as Error).message ?? err); });

    const patUser: PatUser = {
      userId,
      orgId,
      tenantIds,
      role,
      tokenScopes,
      authMethod: "pat",
    };
    const displayName = boundedDisplayString(row.username, 256);
    if (displayName) patUser.displayName = displayName;
    return patUser;
  }

  oidcEnabled(): boolean {
    return Boolean(this.oidcVerifier);
  }

  async resolveOidc(token: string): Promise<PatUser> {
    if (!this.oidcVerifier) {
      throw new Error("oidc_not_configured");
    }
    try {
      return this.userFromOidcPrincipal(await this.oidcVerifier.verify(token));
    } catch (err) {
      if (err instanceof OidcAuthError) {
        throw new Error(`invalid_oidc_token:${err.code}`, { cause: err });
      }
      if (err instanceof Error && err.message.startsWith("invalid_")) {
        throw new Error("invalid_oidc_token:invalid_claims", { cause: err });
      }
      throw err;
    }
  }

  toSynesisMcpAuth(user: PatUser, bearerToken: string): SynesisMcpAuth {
    return {
      bearerToken,
      userId: user.userId,
      orgId: user.orgId,
      tenantIds: user.tenantIds,
      ...(user.aclGroups?.length ? { aclGroups: user.aclGroups } : {}),
    };
  }

  private userFromOidcPrincipal(principal: OidcVerifiedPrincipal): PatUser {
    let role: McpPrincipalRole = "user";
    if (principal.realmRoles.includes("synesis-admin")) {
      role = "platform_admin";
    } else if (principal.realmRoles.includes("synesis-org-admin") || principal.orgRoles.includes("admin")) {
      role = "org_admin";
    }
    const user: PatUser = {
      userId: canonicalSecurityId(principal.userId, "user_id"),
      orgId: optionalCanonicalOrgId(principal.orgId),
      tenantIds: [],
      role,
      tokenScopes: normalizeTokenScopeList(principal.scopes, ["mcp:invoke", "coder:oidc"]),
      authMethod: "oidc",
    };
    const displayName = boundedDisplayString(principal.displayName, 256);
    if (displayName) user.displayName = displayName;
    return user;
  }

  private hashPat(token: string): string {
    return hashPatToken(token, this.pepper);
  }
}
