import crypto from "node:crypto";
import { Pool } from "pg";
import {
  createOidcVerifierFromEnv,
  OidcAuthError,
  type OidcTokenVerifier,
  type OidcVerifiedPrincipal,
} from "@synesis/oidc-auth";
import type { McpTsConfig } from "./config.js";
import type { SynesisMcpAuth } from "@synesis/mcp-tools";

export interface PatUser {
  userId: string;
  orgId: string;
  tenantIds: string[];
  role: string;
  tokenScopes: string[];
  displayName?: string;
  authMethod?: "pat" | "oidc" | "internal";
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
    const raw = authorizationHeader ?? "";
    if (!raw.toLowerCase().startsWith("bearer ")) {
      throw new Error("Missing Bearer token");
    }
    const token = raw.slice(7).trim();
    if (!token) throw new Error("Missing Bearer token");
    return token;
  }

  requireCoderScope(user: PatUser): void {
    const scopes = user.tokenScopes;
    if (!scopes || scopes.length === 0) {
      throw new Error("Insufficient scope for MCP access");
    }
    if (
      scopes.some((scope) => {
        const s = scope.trim().toLowerCase();
        return s === "coder" || s.startsWith("coder:") || s === "mcp:invoke" || s === "mcp:tool:*" || s.startsWith("mcp:tool:");
      })
    ) {
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
    const orgId = (row.org_id ?? "").trim();
    const tenantIds = (row.tenant_ids ?? [])
      .map((t) => String(t).trim().slice(0, 64))
      .filter(Boolean)
      .slice(0, 50);
    if (tenantIds.length > 0 && !orgId) return null;

    void this.pool
      .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE token_hash = $1", [tokenHash])
      .catch((err) => { console.warn("[auth] PAT last_used update failed:", (err as Error).message ?? err); });

    const patUser: PatUser = {
      userId: row.user_id,
      orgId,
      tenantIds,
      role: row.role ?? "user",
      tokenScopes: row.scopes ?? [],
      authMethod: "pat",
    };
    if (row.username) patUser.displayName = row.username;
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
        throw new Error(`invalid_oidc_token:${err.code}`);
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
    };
  }

  private userFromOidcPrincipal(principal: OidcVerifiedPrincipal): PatUser {
    let role = "user";
    if (principal.realmRoles.includes("synesis-admin")) {
      role = "platform_admin";
    } else if (principal.realmRoles.includes("synesis-org-admin") || principal.orgRoles.includes("admin")) {
      role = "org_admin";
    }
    const user: PatUser = {
      userId: principal.userId,
      orgId: principal.orgId,
      tenantIds: [],
      role,
      tokenScopes: ["mcp:invoke", "coder:oidc", ...principal.scopes],
      authMethod: "oidc",
    };
    if (principal.displayName) user.displayName = principal.displayName;
    return user;
  }

  private hashPat(token: string): string {
    if (!this.pepper) {
      return crypto.createHash("sha256").update(token).digest("hex");
    }
    return crypto.createHmac("sha256", this.pepper).update(token).digest("hex");
  }
}
