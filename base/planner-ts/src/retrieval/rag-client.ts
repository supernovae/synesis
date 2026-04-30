/**
 * NornicDB graph-native RAG retrieval client.
 *
 * Retrieval is intentionally graph-first:
 *   1. Vector search finds seed nodes in the content graph.
 *   2. Cypher filters apply pack, scope, ACL, and temporal constraints.
 *   3. Optional graph expansion follows semantic edges around the seeds.
 *   4. Results are mapped back to the planner's existing RAG result shape.
 */

import neo4j, { type Driver, type QueryResult, type Record as Neo4jRecord } from "neo4j-driver";
import type { RagResult, ScopeFilterOptions } from "./types.js";
import { AUTHORITY_BOOST as AUTH_BOOST } from "./types.js";
import type { MetadataFilterParams } from "./metadata-filter.js";

export interface RagClientConfig {
  nornicUri: string;
  nornicUser: string;
  nornicPassword: string;
  nornicDatabase: string;
  nornicVectorIndex: string;
  nornicRuntimeProfile: "cpu-bge" | "cuda-bge" | "metal-bge";
  embedderModel: string;
  retrievalStrategy: "hybrid" | "vector" | "bm25";
  rrfK: number;
  scoreThreshold: number;
  rerankScoreMin: number;
  graphDepth: number;
  edgeTypes: string[];
  rerankEnabled: boolean;
  timeoutMs?: number;
}

export interface GraphRetrievalOptions {
  collections?: string[];
  topK?: number;
  scopeFilter?: ScopeFilterOptions;
  metadata?: MetadataFilterParams;
  graphDepth?: number;
  edgeTypes?: string[];
  version?: string;
  commit?: string;
  branch?: string;
  temporalAt?: string;
}

type GraphNodeLike = {
  properties?: Record<string, unknown>;
};

type GraphRelationshipLike = {
  type?: string;
  properties?: Record<string, unknown>;
};

const DEFAULT_EDGE_TYPES = ["CONTAINS", "DEFINES", "CALLS", "IMPORTS", "REFERENCES", "OVERRIDES", "IMPLEMENTS", "DOCUMENTS"];
const MAX_GRAPH_DEPTH = 3;

let cachedDriverKey = "";
let cachedDriver: Driver | null = null;

function driverFor(config: RagClientConfig): Driver {
  const key = `${config.nornicUri}|${config.nornicUser}|${config.nornicDatabase}`;
  if (!cachedDriver || cachedDriverKey !== key) {
    if (cachedDriver) {
      void cachedDriver.close();
    }
    cachedDriver = neo4j.driver(config.nornicUri, neo4j.auth.basic(config.nornicUser, config.nornicPassword));
    cachedDriverKey = key;
  }
  return cachedDriver;
}

function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (neo4j.isInt(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function propsOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && "properties" in value) {
    return ((value as GraphNodeLike).properties ?? {}) as Record<string, unknown>;
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function relTypeOf(value: unknown): string {
  if (value && typeof value === "object" && "type" in value) {
    return asString((value as GraphRelationshipLike).type);
  }
  return "";
}

function safeIdent(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 64);
}

function edgePattern(edgeTypes: string[], depth: number): string {
  const safeTypes = edgeTypes.map(safeIdent).filter(Boolean).slice(0, 20);
  const typeExpr = safeTypes.length ? `:${safeTypes.join("|")}` : "";
  const safeDepth = Math.min(Math.max(Math.floor(depth || 0), 0), MAX_GRAPH_DEPTH);
  return `${typeExpr}*1..${safeDepth}`;
}

function buildWhere(
  scope: ScopeFilterOptions | undefined,
  metadata: MetadataFilterParams | undefined,
  temporal: Pick<GraphRetrievalOptions, "version" | "commit" | "branch" | "temporalAt">,
): { clauses: string[]; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  const eq = (prop: string, value: unknown, paramName = prop) => {
    if (value === undefined || value === null || value === "") return;
    params[paramName] = value;
    clauses.push(`node.${prop} = $${paramName}`);
  };

  const contains = (prop: string, value: unknown, paramName = prop) => {
    if (value === undefined || value === null || value === "") return;
    params[paramName] = String(value).toLowerCase();
    clauses.push(`toLower(coalesce(node.${prop}, "")) CONTAINS $${paramName}`);
  };

  if (metadata?.pack_id) {
    eq("pack", metadata.pack_id, "pack_id");
  } else if (metadata?.pack_ids?.length) {
    params.pack_ids = metadata.pack_ids.slice(0, 20);
    clauses.push("node.pack IN $pack_ids");
  }
  eq("pack_version", metadata?.pack_version);
  eq("pack_partition", metadata?.pack_partition);
  eq("symbol_kind", metadata?.symbol_kind);
  eq("symbol_fqn", metadata?.symbol_fqn);
  eq("package_name", metadata?.package_name);
  eq("perf_tier", metadata?.perf_tier);
  eq("language", metadata?.language);
  eq("artifact_kind", metadata?.artifact_kind);
  eq("domain", metadata?.domain);
  eq("corpus_class", metadata?.corpus_class);
  eq("constraint_kind", metadata?.constraint_kind);
  eq("content_profile", metadata?.content_profile);
  eq("constraint_source", metadata?.constraint_source);
  eq("golden_path_id", metadata?.golden_path_id);
  eq("content_format", metadata?.content_format);
  eq("repo_path", metadata?.repo_path);
  eq("module_path", metadata?.module_path);
  eq("symbol_name", metadata?.symbol_name);
  eq("has_code", metadata?.has_code);
  eq("code_language", metadata?.code_language);
  contains("tags", metadata?.tags);

  if (metadata?.scope_tags?.length) {
    params.scope_tags = metadata.scope_tags.map((tag) => tag.toLowerCase()).slice(0, 10);
    clauses.push("any(tag IN $scope_tags WHERE toLower(coalesce(node.scope_tags, \"\")) CONTAINS tag)");
  }

  eq("source_version", temporal.version, "source_version");
  eq("commit", temporal.commit);
  eq("branch", temporal.branch);
  if (temporal.temporalAt) {
    params.temporal_at = temporal.temporalAt;
    clauses.push("(node.valid_from IS NULL OR node.valid_from <= $temporal_at)");
    clauses.push("(node.valid_to IS NULL OR node.valid_to = \"\" OR node.valid_to >= $temporal_at)");
  }

  const visibilityClauses = ['coalesce(node.visibility_scope, "global") = "global"'];
  if (scope?.callerOrgId) {
    params.caller_org_id = scope.callerOrgId;
    visibilityClauses.push('(node.visibility_scope = "org" AND node.org_id = $caller_org_id)');

    if (scope.callerTenantIds?.length) {
      params.caller_tenant_ids = scope.callerTenantIds.slice(0, 50);
      visibilityClauses.push('(node.visibility_scope = "tenant" AND node.org_id = $caller_org_id AND node.tenant_id IN $caller_tenant_ids)');
    }

    if (scope.callerUserId) {
      params.caller_user_id = scope.callerUserId;
      visibilityClauses.push('(node.visibility_scope = "user" AND node.org_id = $caller_org_id AND node.owner_user_id = $caller_user_id)');

      if (scope.callerConversationId) {
        params.caller_conversation_id = scope.callerConversationId;
        params.now_epoch = Math.floor(Date.now() / 1000);
        visibilityClauses.push('(node.visibility_scope = "session" AND node.org_id = $caller_org_id AND node.owner_user_id = $caller_user_id AND node.conversation_id = $caller_conversation_id AND (coalesce(node.expires_at_epoch, 0) <= 0 OR node.expires_at_epoch >= $now_epoch))');
      }
    }
  }
  clauses.push(`(${visibilityClauses.join(" OR ")})`);

  if (scope?.callerAclGroups?.length) {
    params.caller_acl_groups = scope.callerAclGroups.slice(0, 100);
    clauses.push('(coalesce(node.acl_mode, "open") IN ["open", ""] OR any(group IN $caller_acl_groups WHERE coalesce(node.acl_groups, "") CONTAINS group))');
  } else {
    clauses.push('coalesce(node.acl_mode, "open") IN ["open", ""]');
  }

  return { clauses, params };
}

async function runGraphSearch(
  config: RagClientConfig,
  query: string,
  options: Required<Pick<GraphRetrievalOptions, "topK">> & GraphRetrievalOptions,
): Promise<QueryResult> {
  const depth = Math.min(Math.max(Math.floor(options.graphDepth ?? config.graphDepth), 0), MAX_GRAPH_DEPTH);
  const edges = options.edgeTypes?.length ? options.edgeTypes : config.edgeTypes.length ? config.edgeTypes : DEFAULT_EDGE_TYPES;
  const { clauses, params } = buildWhere(options.scopeFilter, options.metadata, {
    version: options.version,
    commit: options.commit,
    branch: options.branch,
    temporalAt: options.temporalAt,
  });

  const limit = Math.min(Math.max(options.topK * 2, 1), 100);
  const where = clauses.length ? `WHERE ${clauses.join("\n  AND ")}` : "";
  const expansion = depth > 0
    ? `
OPTIONAL MATCH path=(node)-[rels${edgePattern(edges, depth)}]-(neighbor)
WITH node, score,
     collect(DISTINCT neighbor)[0..12] AS neighbors,
     reduce(acc = [], r IN collect(rels) | acc + r)[0..24] AS edge_list`
    : `
WITH node, score, [] AS neighbors, [] AS edge_list`;

  const cypher = `
CALL db.index.vector.queryNodes($index_name, $limit, $query)
YIELD node, score
${where}
${expansion}
RETURN node, score, neighbors, edge_list
ORDER BY score DESC
LIMIT $result_limit
`;

  const session = driverFor(config).session({ database: config.nornicDatabase });
  try {
    return await session.run(cypher, {
      ...params,
      index_name: config.nornicVectorIndex,
      query,
      limit,
      result_limit: options.topK,
    }, { timeout: config.timeoutMs ?? 15000 });
  } finally {
    await session.close();
  }
}

function graphTrace(record: Neo4jRecord): string {
  const neighbors = (record.get("neighbors") ?? []) as unknown[];
  const edgeList = (record.get("edge_list") ?? []) as unknown[];
  const neighborIds = neighbors.map((n) => asString(propsOf(n).id || propsOf(n).chunk_id || propsOf(n).symbol_fqn)).filter(Boolean);
  const relTypes = edgeList.map(relTypeOf).filter(Boolean);
  return JSON.stringify({
    neighbors: neighborIds.slice(0, 12),
    edge_types: [...new Set(relTypes)].slice(0, 12),
  });
}

function toRagResult(record: Neo4jRecord, fallbackScore: number): RagResult {
  const row = propsOf(record.get("node"));
  const score = asNumber(record.get("score"), fallbackScore);
  const graphContext = graphTrace(record);

  return {
    chunk_id: asString(row.chunk_id ?? row.id),
    doc_id: asString(row.doc_id ?? row.document_id),
    text: asString(row.text ?? row.content ?? row.summary),
    source: asString(row.source ?? row.path ?? "nornicdb"),
    collection: "content_graph",
    retrieval_source: "hybrid",
    vector_score: score,
    bm25_score: 0,
    rrf_score: score,
    rerank_score: score,
    origin_type: asString(row.origin_type),
    authority: asString(row.authority),
    pack_id: asString(row.pack ?? row.pack_id ?? "global"),
    pack_version: asString(row.pack_version),
    pack_source_version: asString(row.source_version ?? row.pack_source_version),
    pack_artifact_hash: asString(row.pack_artifact_hash),
    pack_partition: asString(row.pack_partition),
    symbol_kind: asString(row.symbol_kind ?? row.kind),
    symbol_fqn: asString(row.symbol_fqn),
    symbol_name: asString(row.symbol_name),
    package_name: asString(row.package_name),
    doc_relation_ids: asString(row.doc_relation_ids),
    agent_hook: asString(row.agent_hook),
    perf_tier: asString(row.perf_tier),
    safety_contract: asString(row.safety_contract),
    lifecycle_model: asString(row.lifecycle_model),
    agent_enrichment_json: asString(row.agent_enrichment_json || graphContext),
    domain: asString(row.domain),
    source_url: asString(row.source_url ?? row.url),
    source_type: asString(row.source_type),
    handler: asString(row.handler),
    heading_path: asString(row.heading_path),
    context_prefix: asString(row.context_prefix),
    chunk_summary: asString(row.chunk_summary ?? row.summary),
    document_name: asString(row.document_name ?? row.name ?? row.path),
    scan_status: asString(row.scan_status, "unscanned"),
    scan_signals: asString(row.scan_signals),
    approval_status: asString(row.approval_status, "auto_approved"),
    review_trace_id: asString(row.review_trace_id),
    content_hash: asString(row.raw_content_hash ?? row.content_hash),
    crawl_timestamp: asNumber(row.crawl_timestamp, 0),
    effective_at_epoch: asNumber(row.effective_at_epoch, 0),
    tags: asString(row.tags),
    language: asString(row.language),
    artifact_kind: asString(row.artifact_kind),
    content_format: asString(row.content_format),
    repo_path: asString(row.repo_path ?? row.path),
    module_path: asString(row.module_path),
    corpus_class: asString(row.corpus_class),
    constraint_kind: asString(row.constraint_kind),
    content_profile: asString(row.content_profile),
    scope_tags: asString(row.scope_tags),
    constraint_source: asString(row.constraint_source),
    constraint_confidence: asNumber(row.constraint_confidence, -1),
    golden_path_id: asString(row.golden_path_id),
    novel_pattern: asBoolean(row.novel_pattern),
    novel_trace_level: asString(row.novel_trace_level, "none"),
    has_code: asBoolean(row.has_code),
    code_signal_count: asNumber(row.code_signal_count, 0),
    code_density: asNumber(row.code_density, 0),
    code_language: asString(row.code_language),
  };
}

/**
 * Retrieve documents from NornicDB, expand graph context, and apply authority boosts.
 */
export async function retrieveContext(
  query: string,
  config: RagClientConfig,
  options: GraphRetrievalOptions = {},
): Promise<RagResult[]> {
  const topK = options.topK ?? 5;
  if (!config.nornicUri || !query.trim()) return [];

  const result = await runGraphSearch(config, query, { ...options, topK });
  const mapped = result.records.map((record, i) => toRagResult(record, 1 / (i + 1)));

  for (const row of mapped) {
    const boost = AUTH_BOOST[row.authority] ?? 1.0;
    row.rerank_score = row.rerank_score * boost;
  }

  mapped.sort((a, b) => {
    const aScore = a.rerank_score > 0 ? a.rerank_score : a.rrf_score;
    const bScore = b.rerank_score > 0 ? b.rerank_score : b.rrf_score;
    return bScore - aScore;
  });

  if (config.rerankScoreMin > 0 && config.rerankEnabled) {
    return mapped.filter((row) => row.rerank_score >= config.rerankScoreMin);
  }
  return mapped.slice(0, topK);
}
