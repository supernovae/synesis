import crypto from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { buildPgPoolConfig } from "../db/pg-pool-config.js";
import type { SearchResult, WebSearchAttribution } from "./types.js";

export interface WebSearchLogSinkDeps {
  adminDbUrl: string;
  logger: { warn: (obj: unknown, msg?: string) => void };
}

export interface PersistWebSearchArgs {
  query: string;
  profile: "web" | "code";
  results: SearchResult[];
  latencyMs: number;
  outcome: "success" | "error" | "empty";
  policyAction: "allow" | "deny" | "degraded";
  blockedReason?: string;
  attribution: WebSearchAttribution;
  errorMessage?: string;
}

let pool: Pool | null = null;
let poolDsn = "";

function optionalString(value: string | undefined): string {
  return (value ?? "").trim();
}

function queryHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getTenantId(attribution: WebSearchAttribution): string {
  return attribution.caller_tenant_ids?.[0] ?? "";
}

function buildRateBucketKey(attribution: WebSearchAttribution): string {
  const org = optionalString(attribution.caller_org_id) || "no-org";
  const user = optionalString(attribution.caller_user_id) || "no-user";
  const surface = optionalString(attribution.source_surface) || "unknown";
  return `${org}:${user}:${surface}`;
}

function getPool(deps: WebSearchLogSinkDeps): Pool | null {
  const dsn = deps.adminDbUrl.trim();
  if (!dsn) return null;
  if (!pool || poolDsn !== dsn) {
    pool = new Pool(buildPgPoolConfig(dsn, 5));
    poolDsn = dsn;
  }
  return pool;
}

async function insertOne(client: PoolClient, args: PersistWebSearchArgs, row: SearchResult | null): Promise<void> {
  const nowSec = Date.now() / 1000;
  const qHash = queryHash(args.query);
  const attribution = args.attribution;
  const requestId = optionalString(attribution.request_id);
  const traceId = optionalString(attribution.trace_id) || requestId;
  const sourceSurface = optionalString(attribution.source_surface);
  const toolName = optionalString(attribution.tool_name);
  const orgId = optionalString(attribution.caller_org_id);
  const userId = optionalString(attribution.caller_user_id);
  const tenantId = getTenantId(attribution);
  const sessionKey = optionalString(attribution.session_key);
  const conversationId = optionalString(attribution.conversation_id);
  const rateBucket = buildRateBucketKey(attribution);
  const tokenEstimate = Math.max(1, Math.ceil(args.query.length / 4));
  const blockedReason = optionalString(args.blockedReason);
  const policyAction = optionalString(args.policyAction);
  const sourceId = row?.source_id ?? "";
  const url = row?.url ?? "";
  let domain = "";
  try {
    if (url) domain = new URL(url).hostname;
  } catch {
    domain = "";
  }
  await client.query(
    `
      INSERT INTO web_search_log (
        timestamp, run_id, query, source_id, profile, url, domain, title, snippet, score,
        latency_ms, outcome, engine, org_id, user_id, tenant_id, request_id, session_key,
        conversation_id, trace_id, source_surface, tool_name, query_hash, rate_bucket_key,
        blocked_reason, policy_action, token_estimate
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, $26, $27
      )
    `,
    [
      nowSec,
      requestId || traceId || crypto.randomUUID(),
      args.query,
      sourceId,
      args.profile,
      url,
      domain,
      row?.title ?? "",
      row?.snippet ?? args.errorMessage ?? "",
      row?.relevance ?? row?.score ?? 0,
      args.latencyMs,
      args.outcome,
      row?.engine ?? "",
      orgId,
      userId,
      tenantId,
      requestId,
      sessionKey,
      conversationId,
      traceId,
      sourceSurface,
      toolName,
      qHash,
      rateBucket,
      blockedReason,
      policyAction,
      tokenEstimate,
    ],
  );
}

export async function persistWebSearchLog(
  deps: WebSearchLogSinkDeps,
  args: PersistWebSearchArgs,
): Promise<void> {
  const db = getPool(deps);
  if (!db) return;
  const rows = args.results.length > 0 ? args.results : [null];
  try {
    const client = await db.connect();
    try {
      for (const row of rows) {
        await insertOne(client, args, row);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    deps.logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        requestId: args.attribution.request_id,
        sourceSurface: args.attribution.source_surface,
      },
      "web_search_log_persist_failed",
    );
  }
}
