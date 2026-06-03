import { Pool } from "pg";
import { hashPatToken } from "@synesis/auth-contracts";
import type { AppConfig } from "../config.js";
import { buildPgPoolConfig } from "../db/pg-pool-config.js";

export interface PatRecord {
  id: string;
  name: string;
  tokenPrefix: string;
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
  pool = new Pool(buildPgPoolConfig(dsn, 5));
  if (!config.SYNESIS_PAT_PEPPER) {
    console.warn("[auth] SYNESIS_PAT_PEPPER is empty — PAT hashing uses plain SHA-256 instead of HMAC. Set a pepper for production deployments.");
  }
}

export async function closePatPool(): Promise<void> {
  await pool?.end();
  pool = null;
}

function hashPat(token: string, pepper: string): string {
  return hashPatToken(token, pepper);
}

export async function resolvePatFromDb(
  token: string,
  pepper: string,
): Promise<PatRecord | null> {
  if (!pool) return null;
  if (!token.startsWith("syn-")) return null;

  const tokenHash = hashPat(token, pepper);
  const result = await pool.query(
    `SELECT id, name, token_prefix, user_id, org_id, tenant_ids, role, scopes
     FROM personal_access_tokens
     WHERE token_hash = $1
       AND revoked = false
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [tokenHash],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0] as {
    id: string;
    name: string | null;
    token_prefix: string | null;
    user_id: string;
    org_id: string | null;
    tenant_ids: string[] | null;
    role: string | null;
    scopes: string[] | null;
  };

  void pool
    .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE token_hash = $1", [tokenHash])
    .catch((err) => { console.warn("[auth] PAT last_used update failed:", (err as Error).message ?? err); });

  const tenantIds = (row.tenant_ids ?? []).map((t) => String(t).trim().slice(0, 64)).filter(Boolean).slice(0, 50);
  const orgId = (row.org_id ?? "").trim();

  if (tenantIds.length > 0 && !orgId) return null;

  return {
    id: row.id,
    name: row.name ?? "API token",
    tokenPrefix: row.token_prefix ?? "",
    userId: row.user_id,
    orgId,
    tenantIds,
    role: row.role ?? "user",
    scopes: row.scopes ?? ["model:readonly"],
  };
}
