import crypto from "node:crypto";
import { Pool } from "pg";
import type { AppConfig } from "./config.js";

export interface AuthUser {
  userId: string;
  orgId: string;
  role: string;
  authMethod: "pat" | "bearer";
  tokenScopes: string[];
}

export class AuthResolver {
  private readonly pool: Pool | null;
  private readonly pepper: string;

  constructor(config: AppConfig) {
    this.pool = config.SYNESIS_YARN_ADMIN_DB_URL ? new Pool({ connectionString: config.SYNESIS_YARN_ADMIN_DB_URL }) : null;
    this.pepper = config.SYNESIS_PAT_PEPPER;
  }

  async resolve(authorizationHeader: string | undefined): Promise<AuthUser> {
    const token = this.extractBearerToken(authorizationHeader);
    if (token.startsWith("syn-")) {
      const user = await this.resolvePat(token);
      if (user) return user;
      throw new Error("Invalid token");
    }
    return {
      userId: "bearer-user",
      orgId: "",
      role: "user",
      authMethod: "bearer",
      tokenScopes: []
    };
  }

  requireCoderScope(user: AuthUser): void {
    const scopes = user.tokenScopes;
    if (!scopes || scopes.length === 0) return;
    const allowedPrefixes = ["coder", "model:", "chat:"];
    if (scopes.some((s) => allowedPrefixes.some((p) => s.startsWith(p)))) return;
    throw new Error("Insufficient scope for coder access");
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

  private async resolvePat(token: string): Promise<AuthUser | null> {
    if (!this.pool) return null;
    const tokenHash = this.hashPat(token);
    const result = await this.pool.query(
      `
      SELECT user_id, org_id, role, scopes
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
      role: string | null;
      scopes: string[] | null;
    };
    return {
      userId: row.user_id,
      orgId: row.org_id ?? "",
      role: row.role ?? "user",
      authMethod: "pat",
      tokenScopes: row.scopes ?? ["model:readonly"]
    };
  }
}
