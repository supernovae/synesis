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
import type {
  KnowledgeBundleResponse,
  KnowledgeContextCard,
  KnowledgeResult,
  PackResolveRequest,
  PackResolveResponse,
  RagResult,
  ResolvedPackCandidate,
  ScopeFilterOptions,
} from "./types.js";
import { AUTHORITY_BOOST as AUTH_BOOST } from "./types.js";
import type { MetadataFilterParams } from "./metadata-filter.js";
import { embed } from "./embedder.js";
import { fgaCheck } from "../auth/openfga-client.js";

export interface RagClientConfig {
  nornicUri: string;
  nornicUser: string;
  nornicPassword: string;
  nornicDatabase: string;
  nornicVectorIndex: string;
  nornicRuntimeProfile: "cpu-bge" | "cuda-bge" | "metal-bge";
  embedderUrl: string;
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

const DEFAULT_EDGE_TYPES = [
  "CONTAINS",
  "DEFINES",
  "CALLS",
  "IMPORTS",
  "REFERENCES",
  "OVERRIDES",
  "IMPLEMENTS",
  "DOCUMENTS",
  "HAS_CONSTRAINT",
  "HAS_EXAMPLE",
  "HAS_PATTERN",
  "HAS_CONTEXT_CARD",
  "APPLIES_TO",
  "DEPRECATED_BY",
  "REPLACED_BY",
  "WARNS_ABOUT",
  "RELATED_TO",
];
const MAX_GRAPH_DEPTH = 3;
const DEFAULT_BUNDLE_EDGE_TYPES = [
  "DEFINES",
  "DOCUMENTS",
  "HAS_EXAMPLE",
  "HAS_PATTERN",
  "HAS_CONSTRAINT",
  "HAS_CONTEXT_CARD",
  "APPLIES_TO",
  "DEPRECATED_BY",
  "REPLACED_BY",
  "RELATED_TO",
  "WARNS_ABOUT",
];

let cachedDriverKey = "";
let cachedDriver: Driver | null = null;

function driverFor(config: RagClientConfig): Driver {
  const authMode = config.nornicPassword ? "basic" : "none";
  const key = `${config.nornicUri}|${config.nornicUser}|${config.nornicDatabase}|${authMode}`;
  if (!cachedDriver || cachedDriverKey !== key) {
    if (cachedDriver) {
      void cachedDriver.close();
    }
    cachedDriver = config.nornicPassword
      ? neo4j.driver(config.nornicUri, neo4j.auth.basic(config.nornicUser, config.nornicPassword))
      : neo4j.driver(config.nornicUri);
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean);
  const raw = asString(value).trim();
  if (!raw) return [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => asString(item).trim()).filter(Boolean);
    } catch {
      // fall through to CSV parsing
    }
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
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

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const raw = asString(value).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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

export function addScopeParams(scope: ScopeFilterOptions | undefined, params: Record<string, unknown>): void {
  if (!scope) return;
  if (scope.callerOrgId) params.caller_org_id = scope.callerOrgId;
  if (scope.callerTenantIds?.length) params.caller_tenant_ids = scope.callerTenantIds.slice(0, 50);
  if (scope.callerAclGroups?.length) params.caller_acl_groups = scope.callerAclGroups.slice(0, 100);
  if (scope.callerUserId) params.caller_user_id = scope.callerUserId;
  if (scope.callerConversationId) {
    params.caller_conversation_id = scope.callerConversationId;
    params.now_epoch = Math.floor(Date.now() / 1000);
  }
}

export function buildScopePredicate(alias: string, scope: ScopeFilterOptions | undefined): string {
  const visibilityClauses = [`coalesce(${alias}.visibility_scope, "global") = "global"`];

  if (scope?.callerOrgId) {
    visibilityClauses.push(`(${alias}.visibility_scope = "org" AND ${alias}.org_id = $caller_org_id)`);

    if (scope.callerTenantIds?.length) {
      visibilityClauses.push(`(${alias}.visibility_scope = "tenant" AND ${alias}.org_id = $caller_org_id AND ${alias}.tenant_id IN $caller_tenant_ids)`);
    }

    if (scope.callerUserId) {
      visibilityClauses.push(`(${alias}.visibility_scope = "user" AND ${alias}.org_id = $caller_org_id AND ${alias}.owner_user_id = $caller_user_id)`);

      if (scope.callerConversationId) {
        visibilityClauses.push(`(${alias}.visibility_scope = "session" AND ${alias}.org_id = $caller_org_id AND ${alias}.owner_user_id = $caller_user_id AND ${alias}.conversation_id = $caller_conversation_id AND (coalesce(${alias}.expires_at_epoch, 0) <= 0 OR ${alias}.expires_at_epoch >= $now_epoch))`);
      }
    }
  }

  const aclClause = scope?.authzMode === "enforce" && scope.callerUserId
    ? `coalesce(${alias}.acl_mode, "open") IN ["open", "", "restricted", "private"]`
    : scope?.callerAclGroups?.length
    ? `(coalesce(${alias}.acl_mode, "open") IN ["open", ""] OR any(group IN $caller_acl_groups WHERE group IN coalesce(${alias}.acl_group_ids, []) OR group IN [g IN split(coalesce(${alias}.acl_groups, ""), ",") | trim(g)]))`
    : `coalesce(${alias}.acl_mode, "open") IN ["open", ""]`;

  return `((${visibilityClauses.join(" OR ")}) AND ${aclClause})`;
}

function buildWhere(
  scope: ScopeFilterOptions | undefined,
  metadata: MetadataFilterParams | undefined,
  temporal: Pick<GraphRetrievalOptions, "version" | "commit" | "branch" | "temporalAt">,
): { clauses: string[]; params: Record<string, unknown>; neighborAuthzClause: string } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  addScopeParams(scope, params);

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

  clauses.push(buildScopePredicate("node", scope));

  return { clauses, params, neighborAuthzClause: buildScopePredicate("neighbor", scope) };
}

async function runGraphSearch(
  config: RagClientConfig,
  query: string,
  options: Required<Pick<GraphRetrievalOptions, "topK">> & GraphRetrievalOptions,
): Promise<QueryResult> {
  const depth = Math.min(Math.max(Math.floor(options.graphDepth ?? config.graphDepth), 0), MAX_GRAPH_DEPTH);
  const edges = options.edgeTypes?.length ? options.edgeTypes : config.edgeTypes.length ? config.edgeTypes : DEFAULT_EDGE_TYPES;
  const { clauses, params, neighborAuthzClause } = buildWhere(options.scopeFilter, options.metadata, {
    version: options.version,
    commit: options.commit,
    branch: options.branch,
    temporalAt: options.temporalAt,
  });

  const limit = Math.min(Math.max(options.topK * 2, 1), 100);
  const queryVector = config.embedderUrl
    ? (await embed([query], {
        url: config.embedderUrl,
        model: config.embedderModel,
        timeoutMs: config.timeoutMs ?? 10000,
      }))[0]
    : [];
  const vectorQuery = queryVector?.length ? queryVector : query;
  const where = clauses.length ? `WHERE ${clauses.join("\n  AND ")}` : "";
  const expansion = depth > 0
    ? `
OPTIONAL MATCH path=(node)-[rels${edgePattern(edges, depth)}]-(neighbor)
WHERE ${neighborAuthzClause}
WITH node, score,
     collect(DISTINCT neighbor)[0..12] AS neighbors,
     reduce(acc = [], r IN collect(coalesce(rels, [])) | acc + r)[0..24] AS edge_list`
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
      query: vectorQuery,
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

function ragResultFromProps(row: Record<string, unknown>, score: number, graphContext = "{}"): RagResult {
  const enrichment = parseJsonRecord(row.agent_enrichment_json);

  return {
    id: asString(row.id ?? row.chunk_id),
    kind: asString(row.kind),
    name: asString(row.name),
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
    content_type: asString(row.content_type),
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
    visibility_scope: asString(row.visibility_scope, "global"),
    acl_mode: asString(row.acl_mode, "open"),
    authz_object_id: asString(row.authz_object_id),
    query_aliases: asString(row.query_aliases ?? enrichment.query_aliases),
    retrieval_terms: asString(row.retrieval_terms ?? enrichment.retrieval_terms),
    task_intents: asString(row.task_intents ?? enrichment.task_intents),
    source_release: asString(row.source_release),
    upstream_commit: asString(row.upstream_commit ?? row.commit),
    upstream_tag: asString(row.upstream_tag),
    deprecation_status: asString(row.deprecation_status),
    replacement_api: asString(row.replacement_api),
    deprecated: asBoolean(row.deprecated),
    quality_score: asNumber(row.quality_score, -1),
    trust_score: asNumber(row.trust_score, -1),
    freshness_score: asNumber(row.freshness_score, -1),
    runnable: asBoolean(row.runnable),
    anti_example: asBoolean(row.anti_example),
    imports: asString(row.imports),
    setup: asString(row.setup),
    expected_output: asString(row.expected_output),
    test_command: asString(row.test_command),
    related_apis: asString(row.related_apis),
  };
}

function toRagResult(record: Neo4jRecord, fallbackScore: number): RagResult {
  return ragResultFromProps(
    propsOf(record.get("node")),
    asNumber(record.get("score"), fallbackScore),
    graphTrace(record),
  );
}

function parseAuthzObject(value: string): { objectType: string; objectId: string } | null {
  const idx = value.indexOf(":");
  if (idx <= 0 || idx >= value.length - 1) return null;
  return {
    objectType: value.slice(0, idx),
    objectId: value.slice(idx + 1),
  };
}

function needsFgaCheck(row: RagResult): boolean {
  const visibility = (row.visibility_scope ?? "global").trim().toLowerCase();
  const aclMode = (row.acl_mode ?? "open").trim().toLowerCase();
  return visibility !== "global" || !["", "open"].includes(aclMode);
}

async function filterByFga(rows: RagResult[], scope: ScopeFilterOptions | undefined): Promise<RagResult[]> {
  if (scope?.authzMode !== "enforce") return rows;
  const callerUserId = scope.callerUserId?.trim();
  if (!callerUserId) return rows.filter((row) => !needsFgaCheck(row));

  const out: RagResult[] = [];
  for (const row of rows) {
    if (!needsFgaCheck(row)) {
      out.push(row);
      continue;
    }

    const authzObject = parseAuthzObject(row.authz_object_id ?? "");
    if (!authzObject) continue;
    const decision = await fgaCheck(`user:${callerUserId}`, "can_read", authzObject.objectType, authzObject.objectId);
    if (decision.allowed) out.push(row);
  }
  return out;
}

function searchTerms(...values: Array<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const raw = asString(value).toLowerCase();
    for (const part of raw.split(/[^a-z0-9_./:-]+/i)) {
      const item = part.trim();
      if (item.length < 2 || seen.has(item)) continue;
      seen.add(item);
      out.push(item.slice(0, 128));
      if (out.length >= 16) return out;
    }
  }
  return out;
}

function addOptionalResolverFilters(
  clauses: string[],
  params: Record<string, unknown>,
  request: PackResolveRequest,
): void {
  const eq = (prop: string, value: unknown, paramName = prop) => {
    const s = asString(value).trim();
    if (!s) return;
    params[paramName] = s;
    clauses.push(`node.${prop} = $${paramName}`);
  };
  eq("domain", request.domain);
  eq("content_type", request.content_type);
  eq("language", request.language);
  eq("package_name", request.package_name);
  if (request.version) {
    params.requested_version = request.version;
    clauses.push("(node.source_version = $requested_version OR node.pack_version = $requested_version)");
  }
}

function resolverTextPredicate(): string {
  return `(
    $terms = [] OR any(term IN $terms WHERE
      toLower(coalesce(node.pack, node.pack_id, "")) CONTAINS term OR
      toLower(coalesce(node.name, "")) CONTAINS term OR
      toLower(coalesce(node.domain, "")) CONTAINS term OR
      toLower(coalesce(node.content_type, "")) CONTAINS term OR
      toLower(coalesce(node.language, "")) CONTAINS term OR
      toLower(coalesce(node.package_name, "")) CONTAINS term OR
      toLower(coalesce(node.symbol_fqn, "")) CONTAINS term OR
      toLower(coalesce(node.symbol_name, "")) CONTAINS term OR
      toLower(coalesce(node.retrieval_terms, "")) CONTAINS term OR
      toLower(coalesce(node.query_aliases, "")) CONTAINS term OR
      toLower(coalesce(node.task_intents, "")) CONTAINS term
    )
  )`;
}

function rowToResolvedPack(row: Neo4jRecord): ResolvedPackCandidate {
  return {
    pack_id: asString(row.get("pack_id")),
    pack_version: asString(row.get("pack_version")),
    source_version: asString(row.get("source_version")),
    source_release: asString(row.get("source_release")),
    domain: asString(row.get("domain")),
    content_type: asString(row.get("content_type")),
    language: asString(row.get("language")),
    package_name: asString(row.get("package_name")),
    trust_score: asNumber(row.get("trust_score"), -1),
    quality_score: asNumber(row.get("quality_score"), -1),
    freshness_score: asNumber(row.get("freshness_score"), -1),
    node_count: asNumber(row.get("node_count"), 0),
    chunk_count: asNumber(row.get("chunk_count"), 0),
    example_count: asNumber(row.get("example_count"), 0),
    context_card_count: asNumber(row.get("context_card_count"), 0),
    pattern_count: asNumber(row.get("pattern_count"), 0),
    constraint_count: asNumber(row.get("constraint_count"), 0),
    edge_count: asNumber(row.get("edge_count"), 0),
    score: asNumber(row.get("score"), 0),
  };
}

export async function resolvePacks(
  request: PackResolveRequest,
  config: RagClientConfig,
  scopeFilter?: ScopeFilterOptions,
): Promise<PackResolveResponse> {
  if (!config.nornicUri) return { query: asString(request.query), candidates: [], total: 0 };
  const terms = searchTerms(request.query, request.package_name, request.symbol, request.language, request.domain);
  const clauses = [
    "coalesce(node.pack, node.pack_id, \"\") <> \"\"",
    buildScopePredicate("node", scopeFilter),
    scopeFilter?.authzMode === "enforce" ? "coalesce(node.acl_mode, \"open\") IN [\"open\", \"\"]" : "true",
    resolverTextPredicate(),
  ];
  const params: Record<string, unknown> = {
    terms,
    limit: Math.min(Math.max(Math.trunc(request.top_k ?? 5), 1), 20),
    symbol: asString(request.symbol).trim(),
  };
  addScopeParams(scopeFilter, params);
  addOptionalResolverFilters(clauses, params, request);
  if (params.symbol) {
    clauses.push(`(
      node.symbol_fqn = $symbol OR node.symbol_name = $symbol OR node.name = $symbol OR
      toLower(coalesce(node.symbol_fqn, "")) CONTAINS toLower($symbol) OR
      toLower(coalesce(node.retrieval_terms, "")) CONTAINS toLower($symbol)
    )`);
  }

  const cypher = `
MATCH (node:ContentNode)
WHERE ${clauses.join("\n  AND ")}
WITH coalesce(node.pack, node.pack_id, "") AS pack_id, node
WITH pack_id,
     count(node) AS node_count,
     sum(CASE WHEN coalesce(node.kind, "Chunk") = "Chunk" AND node.text IS NOT NULL THEN 1 ELSE 0 END) AS chunk_count,
     sum(CASE WHEN coalesce(node.kind, "") = "Example" THEN 1 ELSE 0 END) AS example_count,
     sum(CASE WHEN coalesce(node.kind, "") = "ContextCard" THEN 1 ELSE 0 END) AS context_card_count,
     sum(CASE WHEN coalesce(node.kind, "") = "Pattern" THEN 1 ELSE 0 END) AS pattern_count,
     sum(CASE WHEN coalesce(node.kind, "") = "Constraint" THEN 1 ELSE 0 END) AS constraint_count,
     collect(node)[0] AS sample
OPTIONAL MATCH (a:ContentNode)-[r]-(b:ContentNode)
WHERE (a.pack = pack_id OR a.pack_id = pack_id) AND (b.pack = pack_id OR b.pack_id = pack_id)
WITH pack_id, sample, node_count, chunk_count, example_count, context_card_count, pattern_count, constraint_count,
     count(DISTINCT r) AS edge_count
WITH pack_id, sample, node_count, chunk_count, example_count, context_card_count, pattern_count, constraint_count, edge_count,
     (node_count + example_count * 3 + context_card_count * 4 + pattern_count * 2 + constraint_count * 2) AS score
RETURN pack_id,
       coalesce(sample.pack_version, "") AS pack_version,
       coalesce(sample.source_version, sample.pack_source_version, "") AS source_version,
       coalesce(sample.source_release, "") AS source_release,
       coalesce(sample.domain, "") AS domain,
       coalesce(sample.content_type, "") AS content_type,
       coalesce(sample.language, "") AS language,
       coalesce(sample.package_name, "") AS package_name,
       coalesce(sample.trust_score, -1.0) AS trust_score,
       coalesce(sample.quality_score, -1.0) AS quality_score,
       coalesce(sample.freshness_score, -1.0) AS freshness_score,
       node_count, chunk_count, example_count, context_card_count, pattern_count, constraint_count, edge_count, score
ORDER BY score DESC, pack_id
LIMIT $limit
`;
  const session = driverFor(config).session({ database: config.nornicDatabase });
  try {
    const result = await session.run(cypher, params, { timeout: config.timeoutMs ?? 15000 });
    const candidates = result.records.map(rowToResolvedPack);
    return { query: asString(request.query), candidates, total: candidates.length };
  } finally {
    await session.close();
  }
}

interface TypedNodeQuery {
  query: string;
  packId?: string;
  kinds: string[];
  topic?: string;
  symbol?: string;
  task?: string;
  version?: string;
  language?: string;
  artifactKind?: string;
  limit?: number;
}

async function findTypedNodes(
  config: RagClientConfig,
  input: TypedNodeQuery,
  scopeFilter?: ScopeFilterOptions,
): Promise<RagResult[]> {
  if (!config.nornicUri) return [];
  const terms = searchTerms(input.query, input.topic, input.symbol, input.task);
  const clauses = [
    "node.kind IN $kinds",
    buildScopePredicate("node", scopeFilter),
    resolverTextPredicate(),
  ];
  const params: Record<string, unknown> = {
    kinds: input.kinds,
    terms,
    limit: Math.min(Math.max(Math.trunc(input.limit ?? 6), 1), 25),
    symbol: asString(input.symbol).trim(),
  };
  addScopeParams(scopeFilter, params);
  const eq = (prop: string, value: unknown, paramName = prop) => {
    const s = asString(value).trim();
    if (!s) return;
    params[paramName] = s;
    clauses.push(`node.${prop} = $${paramName}`);
  };
  if (input.packId) {
    params.pack_id = input.packId;
    clauses.push("(node.pack = $pack_id OR node.pack_id = $pack_id)");
  }
  eq("language", input.language);
  eq("artifact_kind", input.artifactKind);
  if (input.version) {
    params.version = input.version;
    clauses.push("(node.source_version = $version OR node.pack_version = $version)");
  }
  if (params.symbol) {
    clauses.push(`(
      node.symbol_fqn = $symbol OR node.symbol_name = $symbol OR node.name = $symbol OR
      toLower(coalesce(node.symbol_fqn, "")) CONTAINS toLower($symbol) OR
      toLower(coalesce(node.text, "")) CONTAINS toLower($symbol)
    )`);
  }

  const cypher = `
MATCH (node:ContentNode)
WHERE ${clauses.join("\n  AND ")}
WITH node,
     CASE
       WHEN $symbol <> "" AND (node.symbol_fqn = $symbol OR node.symbol_name = $symbol OR node.name = $symbol) THEN 4.0
       WHEN $symbol <> "" AND toLower(coalesce(node.text, "")) CONTAINS toLower($symbol) THEN 2.5
       ELSE 1.0
     END + coalesce(node.quality_score, 0.0) + coalesce(node.trust_score, 0.0) AS score
RETURN node, score
ORDER BY score DESC, coalesce(node.name, node.id)
LIMIT $limit
`;
  const session = driverFor(config).session({ database: config.nornicDatabase });
  try {
    const result = await session.run(cypher, params, { timeout: config.timeoutMs ?? 15000 });
    return filterByFga(
      result.records.map((record, i) => ragResultFromProps(propsOf(record.get("node")), asNumber(record.get("score"), 1 / (i + 1)))),
      scopeFilter,
    );
  } finally {
    await session.close();
  }
}

function knowledgeResultFromRag(row: RagResult): KnowledgeResult {
  const scopeTagsStr = row.scope_tags ?? "";
  return {
    text: row.text,
    source_url: row.source_url,
    chunk_id: row.chunk_id ?? "",
    doc_id: row.doc_id ?? "",
    document_name: row.document_name,
    authority: row.authority,
    pack_id: row.pack_id ?? "",
    pack_version: row.pack_version ?? "",
    pack_source_version: row.pack_source_version ?? "",
    pack_partition: row.pack_partition ?? "",
    symbol_kind: row.symbol_kind ?? row.kind ?? "",
    symbol_fqn: row.symbol_fqn ?? "",
    symbol_name: row.symbol_name ?? "",
    package_name: row.package_name ?? "",
    doc_relation_ids: row.doc_relation_ids ? row.doc_relation_ids.split(",").map((s) => s.trim()).filter(Boolean) : [],
    agent_hook: row.agent_hook ?? "",
    perf_tier: row.perf_tier ?? "",
    safety_contract: row.safety_contract ?? "",
    lifecycle_model: row.lifecycle_model ?? "",
    agent_enrichment_json: row.agent_enrichment_json ?? "",
    origin_type: row.origin_type,
    source_type: row.source_type ?? "",
    handler: row.handler ?? "",
    domain: row.domain,
    language: row.language ?? "",
    artifact_kind: row.artifact_kind ?? "",
    content_format: row.content_format ?? "",
    repo_path: row.repo_path ?? "",
    module_path: row.module_path ?? "",
    tags: row.tags ?? "",
    context_prefix: row.context_prefix,
    chunk_summary: row.chunk_summary,
    heading_path: row.heading_path,
    score: row.rerank_score || row.rrf_score || row.vector_score,
    constraint_kind: row.constraint_kind ?? "",
    corpus_class: row.corpus_class ?? "",
    scope_tags: scopeTagsStr ? scopeTagsStr.split(",").map((s) => s.trim()).filter(Boolean) : [],
    content_profile: row.content_profile ?? "",
    constraint_source: row.constraint_source ?? "",
    constraint_confidence: row.constraint_confidence ?? -1,
    golden_path_id: row.golden_path_id ?? "",
    novel_pattern: Boolean(row.novel_pattern),
    has_code: Boolean(row.has_code),
    code_signal_count: row.code_signal_count ?? 0,
    code_density: row.code_density ?? 0,
    code_language: row.code_language ?? "",
    scan_status: row.scan_status ?? "unscanned",
    approval_status: row.approval_status ?? "auto_approved",
  };
}

function contextCardFromRag(row: RagResult, fallbackIndex: number): KnowledgeContextCard {
  const enrichment = parseJsonRecord(row.agent_enrichment_json);
  const title = asString(row.name ?? row.symbol_fqn ?? row.document_name, `Context card ${fallbackIndex + 1}`);
  return {
    title,
    what_to_use: asString(enrichment.what_to_use ?? row.chunk_summary ?? row.text).slice(0, 1600),
    when_to_use: asString(enrichment.when_to_use ?? row.context_prefix).slice(0, 1200),
    do_not_use: asString(enrichment.do_not_use ?? enrichment.hidden_warnings ?? row.deprecation_status).slice(0, 1200),
    minimal_example: asString(enrichment.minimal_example ?? row.text).slice(0, 2000),
    verification: asString(enrichment.verification ?? row.test_command ?? row.safety_contract).slice(0, 1200),
    related_apis: asStringArray(enrichment.related_apis ?? row.related_apis).slice(0, 12),
    source_refs: [row.source_url, row.doc_id, row.symbol_fqn].map((v) => asString(v)).filter(Boolean).slice(0, 8),
    score: row.rerank_score || row.rrf_score || row.vector_score,
  };
}

function sourceVersionWarning(requested: string | undefined, resolved: ResolvedPackCandidate | undefined): string[] {
  const wanted = asString(requested).trim();
  if (!wanted || !resolved) return [];
  const actual = resolved.source_version || resolved.pack_version;
  if (!actual || actual === wanted) return [];
  return [`Requested version ${wanted}, but resolved ${resolved.pack_id} is indexed from ${actual}.`];
}

export async function retrieveKnowledgeBundle(
  request: {
    query: string;
    topK?: number;
    packId?: string;
    topic?: string;
    symbol?: string;
    task?: string;
    version?: string;
    language?: string;
    domain?: string;
    contentType?: string;
    packageName?: string;
    artifactKind?: string;
    includeExamples?: boolean;
    includeAntipatterns?: boolean;
    includeContextCards?: boolean;
    metadata?: MetadataFilterParams;
    graphDepth?: number;
    edgeTypes?: string[];
  },
  config: RagClientConfig,
  scopeFilter?: ScopeFilterOptions,
): Promise<KnowledgeBundleResponse> {
  const started = performance.now();
  const resolveStart = performance.now();
  const resolve = await resolvePacks(
    {
      query: request.query,
      domain: request.domain,
      content_type: request.contentType,
      language: request.language,
      package_name: request.packageName,
      symbol: request.symbol,
      version: request.version,
      top_k: 5,
    },
    config,
    scopeFilter,
  );
  const resolvedPack = request.packId
    ? resolve.candidates.find((candidate) => candidate.pack_id === request.packId)
    : resolve.candidates[0];
  const packId = request.packId ?? resolvedPack?.pack_id;
  const resolveMs = performance.now() - resolveStart;

  const searchStart = performance.now();
  const bundleQuery = [request.query, request.topic, request.symbol, request.task].map((v) => asString(v).trim()).filter(Boolean).join("\n");
  const sourceRows = await retrieveContext(bundleQuery || request.query, config, {
    topK: request.topK ?? 8,
    scopeFilter,
    metadata: {
      ...request.metadata,
      pack_id: packId ?? request.metadata?.pack_id,
      package_name: request.packageName ?? request.metadata?.package_name,
      language: request.language ?? request.metadata?.language,
      artifact_kind: request.artifactKind ?? request.metadata?.artifact_kind,
      symbol_fqn: request.metadata?.symbol_fqn,
    },
    graphDepth: request.graphDepth ?? 2,
    edgeTypes: request.edgeTypes?.length ? request.edgeTypes : DEFAULT_BUNDLE_EDGE_TYPES,
    version: request.version,
  });
  const searchMs = performance.now() - searchStart;

  const bundleStart = performance.now();
  const [cardRows, exampleRows, antiPatternRows, symbolRows] = await Promise.all([
    request.includeContextCards === false ? Promise.resolve([]) : findTypedNodes(config, {
      query: request.query,
      packId,
      kinds: ["ContextCard"],
      topic: request.topic,
      symbol: request.symbol,
      task: request.task,
      version: request.version,
      language: request.language,
      artifactKind: request.artifactKind,
      limit: 6,
    }, scopeFilter),
    request.includeExamples === false ? Promise.resolve([]) : findTypedNodes(config, {
      query: request.query,
      packId,
      kinds: ["Example"],
      topic: request.topic,
      symbol: request.symbol,
      task: request.task,
      version: request.version,
      language: request.language,
      artifactKind: request.artifactKind,
      limit: 6,
    }, scopeFilter),
    request.includeAntipatterns === false ? Promise.resolve([]) : findTypedNodes(config, {
      query: [request.query, "avoid deprecated anti-pattern warning replacement", request.task].filter(Boolean).join(" "),
      packId,
      kinds: ["Pattern", "Constraint"],
      topic: request.topic,
      symbol: request.symbol,
      task: request.task,
      version: request.version,
      language: request.language,
      artifactKind: request.artifactKind,
      limit: 6,
    }, scopeFilter),
    findTypedNodes(config, {
      query: request.query,
      packId,
      kinds: ["Symbol", "Concept"],
      topic: request.topic,
      symbol: request.symbol,
      task: request.task,
      version: request.version,
      language: request.language,
      artifactKind: request.artifactKind,
      limit: 8,
    }, scopeFilter),
  ]);

  const contextCards = cardRows.length > 0
    ? cardRows.map(contextCardFromRag)
    : sourceRows.slice(0, 3).map(contextCardFromRag);
  const sourceChunks = sourceRows.map(knowledgeResultFromRag);
  const examples = exampleRows.map(knowledgeResultFromRag);
  const antiPatterns = antiPatternRows.map(knowledgeResultFromRag);
  const relatedSymbols = symbolRows.map(knowledgeResultFromRag);
  const qualityValues = [resolvedPack?.quality_score, ...sourceRows.map((row) => row.quality_score)]
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const trustValues = [resolvedPack?.trust_score, ...sourceRows.map((row) => row.trust_score)]
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const freshnessValues = [resolvedPack?.freshness_score, ...sourceRows.map((row) => row.freshness_score)]
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : -1;
  const bundleMs = performance.now() - bundleStart;

  return {
    query: request.query,
    resolved_pack: resolvedPack,
    context_cards: contextCards,
    examples,
    anti_patterns: antiPatterns,
    source_chunks: sourceChunks,
    related_symbols: relatedSymbols,
    freshness_warnings: sourceVersionWarning(request.version, resolvedPack),
    quality: {
      quality_score: avg(qualityValues),
      trust_score: avg(trustValues),
      freshness_score: avg(freshnessValues),
      evidence_count: sourceChunks.length + relatedSymbols.length,
      example_count: examples.length,
      anti_pattern_count: antiPatterns.length,
      context_card_count: contextCards.length,
    },
    timings: {
      resolve_ms: Math.round(resolveMs * 10) / 10,
      search_ms: Math.round(searchMs * 10) / 10,
      bundle_ms: Math.round(bundleMs * 10) / 10,
      total_ms: Math.round((performance.now() - started) * 10) / 10,
    },
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

  const scoreFiltered = config.rerankScoreMin > 0 && config.rerankEnabled
    ? mapped.filter((row) => row.rerank_score >= config.rerankScoreMin)
    : mapped.slice(0, topK);
  return filterByFga(scoreFiltered, options.scopeFilter);
}
