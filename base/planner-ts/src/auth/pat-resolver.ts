import { Pool } from "pg";
import { hashPatToken, normalizeTokenScopes } from "@synesis/auth-contracts";
import type { AppConfig } from "../config.js";
import { buildPgPoolConfig } from "../db/pg-pool-config.js";

type PlannerPatRole = "readonly" | "user" | "org_admin" | "platform_admin";

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

const SECURITY_ID_RE = /^[^\s,]{1,256}$/;
const ORG_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const TENANT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TOKEN_PREFIX_RE = /^[A-Za-z0-9_-]{0,32}$/;

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

function boundedDisplayString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > maxLength) throw new Error("invalid_display_value");
  return text;
}

function securityId(value: unknown, fieldName: string): string {
  const text = boundedDisplayString(value, 256);
  if (!SECURITY_ID_RE.test(text)) throw new Error(`invalid_${fieldName}`);
  return text;
}

function optionalOrgId(value: unknown): string {
  const text = boundedDisplayString(value, 256);
  if (!text) return "";
  if (!ORG_ID_RE.test(text)) throw new Error("invalid_org_id");
  return text;
}

function normalizeTenantIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("invalid_tenant_ids");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("invalid_tenant_ids");
    const tenantId = raw.trim();
    if (!tenantId) continue;
    if (!TENANT_ID_RE.test(tenantId)) throw new Error("invalid_tenant_ids");
    if (seen.has(tenantId)) continue;
    seen.add(tenantId);
    out.push(tenantId);
    if (out.length > 50) throw new Error("invalid_tenant_ids");
  }
  return out;
}

function normalizeRole(value: unknown): PlannerPatRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  if (role === "admin") return "platform_admin";
  if (role === "readonly" || role === "user" || role === "org_admin" || role === "platform_admin") return role;
  return null;
}

function normalizeTokenPrefix(value: unknown): string {
  const prefix = boundedDisplayString(value, 32);
  if (!TOKEN_PREFIX_RE.test(prefix)) throw new Error("invalid_token_prefix");
  return prefix;
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

  let id: string;
  let tokenPrefix: string;
  let userId: string;
  let orgId: string;
  let tenantIds: string[];
  let role: PlannerPatRole;
  let scopes: string[];
  let name: string;
  try {
    id = securityId(row.id, "pat_id");
    tokenPrefix = normalizeTokenPrefix(row.token_prefix);
    userId = securityId(row.user_id, "user_id");
    orgId = optionalOrgId(row.org_id);
    tenantIds = normalizeTenantIds(row.tenant_ids);
    const parsedRole = normalizeRole(row.role ?? "user");
    if (!parsedRole) return null;
    role = parsedRole;
    scopes = normalizeTokenScopes(row.scopes ?? undefined, ["model:readonly"]);
    name = boundedDisplayString(row.name, 128) || "API token";
  } catch {
    return null;
  }

  if (tenantIds.length > 0 && !orgId) return null;

  void pool
    .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE token_hash = $1", [tokenHash])
    .catch((err) => { console.warn("[auth] PAT last_used update failed:", (err as Error).message ?? err); });

  return {
    id,
    name,
    tokenPrefix,
    userId,
    orgId,
    tenantIds,
    role,
    scopes,
  };
}
