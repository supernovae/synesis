/**
 * Router node — sole retrieval orchestrator.
 *
 * Governs all evidence acquisition (RAG + web). No other node may import
 * retrieval modules directly (see router-governed-evidence rule).
 *
 * Router node behavior:
 *   - Parallel evidence_requests dispatch
 *   - Domain-profile-aware cohesion preseed for focused frames
 *   - topic_frame and domain_hints injection into retrieval
 *   - Evidence packet synthesis with confidence gating
 */

import { EvidencePacketSchema, type EvidencePacket } from "../contracts/schemas.js";
import type { GraphState } from "../state/types.js";
import { validateWithRepair } from "../validation/json-repair.js";
import { NullRetrievalClient, type RetrievalClient } from "../retrieval/client.js";
import type { UnifiedResult, CohesionLockData, RetrievalBundle, UnifiedRetrievalRequest } from "../retrieval/types.js";
import { buildExclusionSignals, getConflictGroups } from "../retrieval/cohesion.js";

export const MAX_DOCS_PER_QUERY = 5;
export const MAX_SNIPPETS_PER_PACKET = 20;
export const LOW_CONFIDENCE_THRESHOLD = 0.4;
const FOCUSED_PRESEED_THRESHOLD = 0.6;
const WEB_QUERY_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "answer",
  "architecture",
  "because",
  "before",
  "build",
  "building",
  "could",
  "design",
  "engineer",
  "engineering",
  "explain",
  "from",
  "give",
  "help",
  "implementation",
  "internal",
  "need",
  "please",
  "practical",
  "production",
  "proposal",
  "ready",
  "should",
  "small",
  "system",
  "team",
  "that",
  "their",
  "there",
  "these",
  "this",
  "useful",
  "want",
  "what",
  "when",
  "where",
  "which",
  "with",
  "within",
  "would",
]);

const WEB_QUERY_PRIORITY_TERMS = [
  "qwen",
  "deepseek",
  "kimi",
  "moonshot",
  "minimax",
  "llm",
  "model",
  "models",
  "coding",
  "coder",
  "assistant",
  "rag",
  "retrieval",
  "embedding",
  "reranker",
  "vllm",
  "bedrock",
  "openrouter",
  "deepinfra",
  "kubernetes",
  "terraform",
  "python",
  "benchmark",
  "benchmarks",
  "release",
  "latest",
  "current",
];

function isTriviallyEmptyEvidencePacket(packet: {
  sources: unknown[];
  snippets: unknown[];
  summary: string;
}): boolean {
  return (
    packet.sources.length === 0 &&
    packet.snippets.length === 0 &&
    !String(packet.summary ?? "").trim()
  );
}

function parseEvidencePacket(query: string, llmOutput: string, rawResults: UnifiedResult[]): EvidencePacket {
  try {
    const parsed = validateWithRepair(llmOutput, EvidencePacketSchema);
    const normalized: EvidencePacket = {
      ...parsed,
      query: parsed.query || query,
      sources: parsed.sources.slice(0, MAX_DOCS_PER_QUERY),
      snippets: parsed.snippets.slice(0, MAX_SNIPPETS_PER_PACKET).map((snippet) => ({
        ...snippet,
        relevance: Math.max(0, Math.min(1, snippet.relevance))
      })),
      confidence: Math.max(0, Math.min(1, parsed.confidence))
    };
    if (rawResults.length > 0 && isTriviallyEmptyEvidencePacket(normalized)) {
      return fallbackPacket(query, rawResults);
    }
    return normalized;
  } catch {
    return fallbackPacket(query, rawResults);
  }
}

function mapApprovalToReview(approval: string | undefined): "unreviewed" | "vetted" | "rejected" {
  switch (approval) {
    case "approved": return "vetted";
    case "rejected": return "rejected";
    default: return "unreviewed";
  }
}

function buildSourceAttribution(result: UnifiedResult): import("@synesis/context-trust").AttributionV1 {
  const authority = (result.authority ?? "external").toLowerCase();
  const validAuthorities = ["canonical", "vetted", "community", "external", "web"] as const;
  const tier = validAuthorities.includes(authority as typeof validAuthorities[number])
    ? (authority as typeof validAuthorities[number])
    : "external";
  const scanStatus = result.scan_status ?? "unscanned";
  const validScanStatuses = ["clean", "flagged", "unscanned"] as const;
  return {
    source_uri: result.source_url || "",
    source_name: result.document_name ?? "",
    authority_tier: tier,
    retrieval_channel: result.retrieval_source === "web" ? "web" : "rag",
    ingest_scan_status: validScanStatuses.includes(scanStatus as typeof validScanStatuses[number])
      ? (scanStatus as typeof validScanStatuses[number]) : "unscanned",
    ingest_scan_signals: result.scan_signals ? result.scan_signals.split(",").filter(Boolean) : [],
    review_status: mapApprovalToReview(result.approval_status),
    review_trace_id: result.review_trace_id || undefined,
    content_hash: result.content_hash ?? "",
    retrieved_at: new Date().toISOString(),
    policy_decision: "allow",
    ingested_at: result.crawl_timestamp ? new Date(result.crawl_timestamp * 1000).toISOString() : undefined,
    effective_at: result.effective_at_epoch ? new Date(result.effective_at_epoch * 1000).toISOString() : undefined,
  };
}

function fallbackPacket(query: string, rawResults: UnifiedResult[]): EvidencePacket {
  const sources = rawResults.slice(0, MAX_DOCS_PER_QUERY).map((result) => ({
    type: (result.retrieval_source === "web" ? "web" : "doc") as "web" | "doc",
    uri: result.source_url || result.title || "unknown",
    metadata: {
      authority: result.authority ?? "",
      origin_type: result.origin_type ?? "",
      heading_path: result.heading_path ?? "",
      document_name: result.document_name ?? "",
      source_id: result.source_id ?? ""
    },
    attribution: buildSourceAttribution(result),
  }));
  const snippets = rawResults.slice(0, MAX_SNIPPETS_PER_PACKET).map((result) => ({
    text: result.text.slice(0, 500),
    relevance: Math.max(0, Math.min(1, result.score)),
    source_uri: result.source_url || result.title || "unknown"
  }));
  const summary = rawResults
    .slice(0, 3)
    .map((result) => result.text.slice(0, 200))
    .join("\n");
  const confidenceRaw =
    rawResults.slice(0, 3).reduce((sum, result) => sum + Math.max(0, Math.min(1, result.score)), 0) /
    Math.max(1, rawResults.slice(0, 3).length);

  return {
    query: query.slice(0, 200),
    sources,
    snippets,
    summary,
    confidence: Math.max(0, Math.min(1, confidenceRaw)),
    retrieval_notes: "Fallback: evidence assembled from raw retrieval results."
  };
}

/**
 * Build a preseeded cohesion lock from conflict groups when the domain
 * profile indicates a focused frame with a dominant domain.
 */
function buildPreseededLock(state: GraphState): CohesionLockData | undefined {
  const profile = state.domain_profile;
  if (!profile || profile.frameCoherence !== "focused") return undefined;
  if (!profile.domains.length) return undefined;

  const dominant = profile.domains[0];
  if (dominant.weight < FOCUSED_PRESEED_THRESHOLD) return undefined;

  const groups = getConflictGroups();
  const domName = dominant.key.toLowerCase();

  for (const members of Object.values(groups)) {
    if (members.has(domName)) {
      return {
        entity: domName,
        type: "specific",
        exclude_signals: buildExclusionSignals(domName),
        confidence: dominant.weight,
        source: "domain_profile",
      };
    }
  }
  return undefined;
}

/**
 * Extract domain hints from the domain profile for taxonomy boost in retrieval.
 */
function extractDomainHints(state: GraphState): string[] {
  const profile = state.domain_profile;
  if (!profile?.domains.length) return [];
  return profile.domains
    .filter((d) => d.weight > 0.1)
    .map((d) => d.key);
}

/**
 * Extract topic_frame string from task_frame if present.
 */
function extractTopicFrame(state: GraphState): string {
  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  return String(taskFrame.topic_frame ?? "");
}

function compactWebQuery(raw: string, state: GraphState, request: Record<string, unknown>): string {
  const explicit = String(request.web_query ?? "").trim();
  if (explicit) return explicit.slice(0, 180);

  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  const frameBits = [
    taskFrame.main_question,
    ...(Array.isArray(taskFrame.technologies) ? taskFrame.technologies : []),
    ...(Array.isArray(taskFrame.domain_tags) ? taskFrame.domain_tags : []),
    ...(state.domain_profile?.domains ?? []).slice(0, 4).map((domain) => domain.key.replace(/_/g, " ")),
  ].filter(Boolean).join(" ");
  const source = `${raw} ${frameBits}`;
  const tokens = source
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9.+#-]{1,}/g) ?? [];

  const selected: string[] = [];
  for (const priority of WEB_QUERY_PRIORITY_TERMS) {
    if (tokens.some((token) => token.includes(priority)) && !selected.includes(priority)) {
      selected.push(priority);
    }
  }
  for (const token of tokens) {
    if (selected.length >= 14) break;
    if (token.length < 3 || WEB_QUERY_STOPWORDS.has(token)) continue;
    if (selected.includes(token)) continue;
    selected.push(token);
  }

  const suffix = selected.some((token) => ["latest", "current", "release", "benchmark", "benchmarks"].includes(token))
    ? ""
    : " current benchmarks";
  const query = `${selected.join(" ")}${suffix}`.trim();
  return (query || raw).slice(0, 180);
}

export async function runRouter(
  state: GraphState,
  deps: { retrievalClient?: RetrievalClient; summarizerOutput?: string } = {}
): Promise<GraphState> {
  const retrievalClient = deps.retrievalClient ?? new NullRetrievalClient();
  const evidenceRequests = state.evidence_requests && state.evidence_requests.length > 0
    ? state.evidence_requests
    : [{ description: state.task_description ?? "user request" }];

  const preseededLock = buildPreseededLock(state);
  const domainHints = extractDomainHints(state);
  const topicFrame = extractTopicFrame(state);
  const difficulty = state.difficulty ?? 0.5;

  const packets: EvidencePacket[] = [];
  const allCohesionLocks: Array<CohesionLockData | null> = [];

  const dispatchOne = async (request: Record<string, unknown>): Promise<void> => {
    const baseQuery = String(request.query ?? request.description ?? state.task_description ?? "evidence request");
    const query = topicFrame ? `${baseQuery} ${topicFrame}`.trim() : baseQuery;
    const skipWeb = request.skip_web === true || request.needs_web === false;

    const client = retrievalClient as RetrievalClient & { retrieveUnified?: RetrievalClient["retrieveUnified"] };
    if (typeof client.retrieveUnified === "function") {
      const unifiedRequest: UnifiedRetrievalRequest = {
        query,
        webQuery: compactWebQuery(baseQuery, state, request),
        difficulty,
        topK: MAX_DOCS_PER_QUERY,
        domainHints,
        skipWeb,
        forceWeb: Boolean(state.force_live_web),
        preseededLock,
        callerOrgId: state.org_id,
        callerTenantIds: state.tenant_ids,
        callerAclGroups: state.acl_groups,
        callerUserId: state.user_id,
        callerConversationId: state.conversation_id,
        authzMode: state.rag_authz_mode,
        authzTraceId: state.authz_trace_id,
        sourceSurface: state.auth_method === "pat" ? "external_api" : "openwebui_planner",
        toolName: "planner_internal",
        requestId: state.authz_trace_id,
        sessionKey: state.conversation_id ? `conversation:${state.conversation_id}` : undefined,
        traceId: state.authz_trace_id,
        progressObserver: (event) => {
          const status =
            event.status === "started" ? "started"
            : event.status === "done" ? "done"
            : "error";
          void state._status_reporter?.(event.phase, status, event.detail);
        },
      };

      const bundle: RetrievalBundle = await client.retrieveUnified(unifiedRequest);
      allCohesionLocks.push(bundle.cohesion_lock);
      const packet = parseEvidencePacket(baseQuery, deps.summarizerOutput ?? "{}", bundle.results);
      packets.push(packet);
    } else {
      const results = await retrievalClient.retrieve({ query, top_k: MAX_DOCS_PER_QUERY });
      const packet = parseEvidencePacket(baseQuery, deps.summarizerOutput ?? "{}", results);
      packets.push(packet);
    }
  };

  await Promise.all(evidenceRequests.map(dispatchOne));

  const activeLock = allCohesionLocks.find(Boolean) ?? null;

  const mergedPackets = [...(state.evidence_packets ?? []), ...packets];

  return {
    ...state,
    evidence_packets: mergedPackets,
    need_more_evidence: packets.some((packet) => packet.confidence < LOW_CONFIDENCE_THRESHOLD),
    next_node: "writer",
    ...(activeLock ? { cohesion_lock: activeLock } : {}),
  };
}
