import crypto from "node:crypto";
import { Pool } from "pg";
export class AuthResolver {
    pool;
    pepper;
    constructor(config) {
        this.pool = config.SYNESIS_YARN_ADMIN_DB_URL ? new Pool({ connectionString: config.SYNESIS_YARN_ADMIN_DB_URL }) : null;
        this.pepper = config.SYNESIS_PAT_PEPPER;
    }
    async resolve(authorizationHeader) {
        const token = this.extractBearerToken(authorizationHeader);
        if (token.startsWith("syn-")) {
            const user = await this.resolvePat(token);
            if (user)
                return user;
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
    requireCoderScope(user) {
        const scopes = user.tokenScopes;
        if (!scopes || scopes.length === 0)
            return;
        const allowedPrefixes = ["coder", "model:", "chat:"];
        if (scopes.some((s) => allowedPrefixes.some((p) => s.startsWith(p))))
            return;
        throw new Error("Insufficient scope for coder access");
    }
    async close() {
        await this.pool?.end();
    }
    extractBearerToken(authorizationHeader) {
        const raw = authorizationHeader ?? "";
        if (!raw.startsWith("Bearer ")) {
            throw new Error("Missing Bearer token");
        }
        const token = raw.slice(7).trim();
        if (!token)
            throw new Error("Missing Bearer token");
        return token;
    }
    hashPat(token) {
        if (!this.pepper) {
            return crypto.createHash("sha256").update(token).digest("hex");
        }
        return crypto.createHmac("sha256", this.pepper).update(token).digest("hex");
    }
    async resolvePat(token) {
        if (!this.pool)
            return null;
        const tokenHash = this.hashPat(token);
        const result = await this.pool.query(`
      SELECT user_id, org_id, role, scopes
      FROM personal_access_tokens
      WHERE token_hash = $1
        AND revoked = false
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
      `, [tokenHash]);
        if (result.rowCount === 0)
            return null;
        const row = result.rows[0];
        return {
            userId: row.user_id,
            orgId: row.org_id ?? "",
            role: row.role ?? "user",
            authMethod: "pat",
            tokenScopes: row.scopes ?? ["model:readonly"]
        };
    }
}
