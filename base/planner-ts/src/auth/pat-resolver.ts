import crypto from "node:crypto";
import { Pool } from "pg";
import type { AppConfig } from "../config.js";

export interface PatRecord {
  userId: string;
  orgId: string;
  tenantIds: string[];
  role: string;
  scopes: string[];
}

let pool: Pool | null = null;

export function initPatPool(config: AppConfig): void {
  const dsn = config.SYNESIS_PLANNER_TS_ADMIN_DB_URL;
  if (!dsn) return;
  pool = new Pool({ connectionString: dsn, max: 5 });
}

export async function closePatPool(): Promise<void> {
  await pool?.end();
  pool = null;
}

function hashPat(token: string, pepper: string): string {
  if (pepper) {
    return crypto.createHmac("sha256", pepper).update(token).digest("hex");
  }
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function resolvePatFromDb(
  token: string,
  pepper: string,
): Promise<PatRecord | null> {
  if (!pool) return null;
  if (!token.startsWith("syn-")) return null;

  const tokenHash = hashPat(token, pepper);
  const result = await pool.query(
    `SELECT user_id, org_id, tenant_ids, role, scopes
     FROM personal_access_tokens
     WHERE token_hash = $1
       AND revoked = false
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [tokenHash],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0] as {
    user_id: string;
    org_id: string | null;
    tenant_ids: string[] | null;
    role: string | null;
    scopes: string[] | null;
  };

  // Fire-and-forget last_used update
  pool
    .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE token_hash = $1", [tokenHash])
    .catch(() => {});

  const tenantIds = (row.tenant_ids ?? []).map((t) => String(t).trim().slice(0, 64)).filter(Boolean).slice(0, 50);
  const orgId = (row.org_id ?? "").trim();

  if (tenantIds.length > 0 && !orgId) return null;

  return {
    userId: row.user_id,
    orgId,
    tenantIds,
    role: row.role ?? "user",
    scopes: row.scopes ?? ["model:readonly"],
  };
}
