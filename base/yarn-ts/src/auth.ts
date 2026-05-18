import crypto from "node:crypto";
import { Pool } from "pg";
import type { AppConfig } from "./config.js";

export interface AuthUser {
  userId: string;
  orgId: string;
  tenantIds: string[];
  role: string;
  authMethod: "pat" | "bearer";
  tokenScopes: string[];
  displayName?: string;
}

export class AuthResolver {
  private readonly pool: Pool | null;
  private readonly pepper: string;

  constructor(config: AppConfig) {
    this.pool = config.SYNESIS_YARN_ADMIN_DB_URL
      ? new Pool({
          connectionString: config.SYNESIS_YARN_ADMIN_DB_URL,
          max: config.SYNESIS_YARN_AUTH_POOL_MAX,
          idleTimeoutMillis: config.SYNESIS_YARN_DB_POOL_IDLE_MS,
          connectionTimeoutMillis: config.SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS,
        })
      : null;
    this.pepper = config.SYNESIS_PAT_PEPPER;
    if (this.pool && !this.pepper) {
      console.warn("[auth] SYNESIS_PAT_PEPPER is empty — PAT hashing uses plain SHA-256 instead of HMAC. Set a pepper for production deployments.");
    }
  }

  async resolve(authorizationHeader: string | undefined): Promise<AuthUser> {
    const token = this.extractBearerToken(authorizationHeader);
    if (token.startsWith("syn-")) {
      const user = await this.resolvePat(token);
      if (user) return user;
      throw new Error("Invalid token");
    }
    const bearerIdentity = this.resolveBearerIdentity(token);
    return {
      userId: bearerIdentity.userId,
      orgId: "",
      tenantIds: [],
      role: "user",
      authMethod: "bearer",
      tokenScopes: ["coder:default"],
      displayName: bearerIdentity.displayName,
    };
  }

  requireCoderScope(user: AuthUser): void {
    const scopes = user.tokenScopes;
    if (!scopes || scopes.length === 0) {
      throw new Error("Insufficient scope for coder access");
    }
    const allowedPrefixes = ["coder", "model:", "chat:"];
    if (scopes.some((s) => allowedPrefixes.some((p) => s.startsWith(p)))) return;
    throw new Error("Insufficient scope for coder access");
  }

  getPoolStats(): { totalCount: number; idleCount: number; waitingCount: number } {
    if (!this.pool) return { totalCount: 0, idleCount: 0, waitingCount: 0 };
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private extractBearerToken(authorizationHeader: string | undefined): string {
    const raw = authorizationHeader ?? "";
    if (!raw.startsWith("Bearer ")) {
      throw new Error("Missing Bearer token");
    }
    const token = raw.slice(7).trim();
    if (!token) throw new Error("Missing Bearer token");
    return token;
  }

  private hashPat(token: string): string {
    if (!this.pepper) {
      return crypto.createHash("sha256").update(token).digest("hex");
    }
    return crypto.createHmac("sha256", this.pepper).update(token).digest("hex");
  }

  private resolveBearerIdentity(token: string): { userId: string; displayName?: string } {
    // Non-PAT bearer tokens are opaque at this layer. Do not derive the
    // authorization principal from unsigned JWT claims.
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
    const identity = { userId: `bearer-${tokenHash}` };

    const payload = this.decodeJwtPayload(token);
    if (payload) {
      const fromEmail = this.safePayloadString(payload, ["email", "preferred_username", "upn"]);
      if (fromEmail) {
        const normalized = fromEmail.toLowerCase();
        return {
          ...identity,
          displayName: normalized,
        };
      }
    }

    return identity;
  }

  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    if (!token.includes(".")) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private safePayloadString(payload: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  private async resolvePat(token: string): Promise<AuthUser | null> {
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
      [tokenHash]
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
    const tenantIds = (row.tenant_ids ?? []).map((t) => String(t).trim().slice(0, 64)).filter(Boolean).slice(0, 50);
    if (tenantIds.length > 0 && !orgId) return null;

    void this.pool
      .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE token_hash = $1", [tokenHash])
      .catch((err) => { console.warn("[auth] PAT last_used update failed:", (err as Error).message ?? err); });

    return {
      userId: row.user_id,
      orgId,
      tenantIds,
      role: row.role ?? "user",
      authMethod: "pat",
      tokenScopes: row.scopes ?? ["model:readonly"],
      displayName: row.username || undefined
    };
  }
}
