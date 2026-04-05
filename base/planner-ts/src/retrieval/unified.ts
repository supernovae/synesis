/**
 * Unified retrieval orchestrator.
 *
 * Ports the Python retrieve_unified() from unified_retrieval.py:
 *   Phase 1: Parallel RAG + web
 *   Phase 2: Map to UnifiedResult
 *   Phase 3: L-RAG adaptive web gating
 *   Phase 3b: Domain policy (prefer/restrict)
 *   Phase 4: RRF merge
 *   Phase 4b: Taxonomy domain hint boost
 *   Phase 4c: Freshness boost (soft preference, trust-gated)
 *   Phase 5: Adaptive top-k (cliff detection)
 *   Phase 5b-5d: Cohesion lock pipeline
 */

import type {
  CohesionLockData,
  RagResult,
  RetrievalBundle,
  SearchResult,
  UnifiedResult,
  UnifiedRetrievalRequest,
} from "./types.js";
import { AUTHORITY_BOOST } from "./types.js";
import { retrieveContext, type RagClientConfig } from "./rag-client.js";
import {
  freshnessScore as _freshnessScore,
  freshnessBoost as _freshnessBoost,
} from "@synesis/context-trust";
import { searchAndProcess, type WebSearchConfig } from "./web-search.js";
import { detectCohesionLock, cohesionFilter, compressToCohesion, type CohesionConfig } from "./cohesion.js";

export interface RetrievalSettings {
  rag: RagClientConfig;
  web: WebSearchConfig;
  cohesion: CohesionConfig;
  rrfK: number;
  overfetchMin: number;
  overfetchMax: number;
  adaptiveGapMultiplier: number;
  domainPolicyMode: "prefer" | "restrict";
  domainPolicyBoost: number;
  webBudgetBase: number;
  webBudgetMax: number;
  freshnessWeight: number;
}

const MIN_RAG_FOR_GATING = 3;
const WEB_GRACE_MS = 500;
const ORIGINAL_WEIGHT = 0.3;
const CODE_INTENT_RE = /\b(code|coding|implement|implementation|function|method|class|interface|api|snippet|example|debug|bug|compile|syntax|refactor|test)\b/i;

// ---------------------------------------------------------------------------
// Phase 2: Map to UnifiedResult
// ---------------------------------------------------------------------------

function ragToUnified(results: RagResult[]): UnifiedResult[] {
  return results.map((r) => ({
    retrieval_source: "rag" as const,
    source_url: r.source_url,
    title: r.document_name || r.source,
    text: r.text.slice(0, 1500),
    score: r.rerank_score > 0 ? r.rerank_score : r.rrf_score,
    authority: r.authority,
    origin_type: r.origin_type,
    heading_path: r.heading_path,
    document_name: r.document_name,
    context_prefix: r.context_prefix,
    chunk_summary: r.chunk_summary,
    domain: r.domain,
    is_trusted: Boolean(r.authority && r.authority !== "external"),
    scan_status: r.scan_status,
    scan_signals: r.scan_signals,
    approval_status: r.approval_status,
    review_trace_id: r.review_trace_id,
    content_hash: r.content_hash,
    crawl_timestamp: r.crawl_timestamp,
    effective_at_epoch: r.effective_at_epoch,
    has_code: r.has_code,
    code_signal_count: r.code_signal_count,
    code_density: r.code_density,
    code_language: r.code_language,
    artifact_kind: r.artifact_kind,
    language: r.language,
  }));
}

function webToUnified(results: SearchResult[]): UnifiedResult[] {
  return results.map((r) => ({
    retrieval_source: "web" as const,
    source_url: r.url,
    source_id: r.source_id,
    title: r.title,
    text: r.fetched_content || r.snippet,
    score: r.relevance,
    authority: r.authority,
    origin_type: r.origin_type,
    is_trusted: r.is_trusted,
  }));
}

// ---------------------------------------------------------------------------
// Phase 4: RRF merge
// ---------------------------------------------------------------------------

function rrfMerge(ragList: UnifiedResult[], webList: UnifiedResult[], k: number): UnifiedResult[] {
  const scored: Array<{ result: UnifiedResult; rrfScore: number }> = [];

  for (let i = 0; i < ragList.length; i++) {
    const rrfScore = (1 / (k + i + 1)) * (1 - ORIGINAL_WEIGHT) + ragList[i].score * ORIGINAL_WEIGHT;
    scored.push({ result: { ...ragList[i], score: rrfScore }, rrfScore });
  }
  for (let i = 0; i < webList.length; i++) {
    const rrfScore = (1 / (k + i + 1)) * (1 - ORIGINAL_WEIGHT) + webList[i].score * ORIGINAL_WEIGHT;
    scored.push({ result: { ...webList[i], score: rrfScore }, rrfScore });
  }

  scored.sort((a, b) => b.rrfScore - a.rrfScore);
  return scored.map((s) => s.result);
}

// ---------------------------------------------------------------------------
// Phase 4b: Taxonomy domain hint boost
// ---------------------------------------------------------------------------

function taxonomyBoost(results: UnifiedResult[], domainHints: string[], boost = 1.15): UnifiedResult[] {
  if (domainHints.length === 0) return results;
  const hintSet = new Set(domainHints.map((h) => h.toLowerCase()));

  return results.map((r) => {
    const docDomain = (r.domain ?? "").toLowerCase();
    const docName = (r.document_name ?? "").toLowerCase();
    const matches = [...hintSet].some((h) => docDomain.includes(h) || docName.includes(h));
    return matches ? { ...r, score: r.score * boost } : r;
  });
}

// ---------------------------------------------------------------------------
// Phase 4c: Freshness scoring — delegated to @synesis/context-trust
// ---------------------------------------------------------------------------

export const freshnessScore = _freshnessScore;
export const freshnessBoost: (results: UnifiedResult[], effectiveWeight?: number) => UnifiedResult[] =
  _freshnessBoost;

// ---------------------------------------------------------------------------
// Phase 5: Adaptive top-k with cliff detection
// ---------------------------------------------------------------------------

function adaptiveTopK(results: UnifiedResult[], maxK: number, gapMultiplier: number): UnifiedResult[] {
  if (results.length <= 3) return results.slice(0, maxK);

  const capped = results.slice(0, maxK);
  for (let i = 1; i < capped.length; i++) {
    const gap = capped[i - 1].score - capped[i].score;
    const avgGap =
      i > 1
        ? (capped[0].score - capped[i - 1].score) / (i - 1)
        : capped[0].score * 0.1;
    if (avgGap > 0 && gap > avgGap * gapMultiplier) {
      return capped.slice(0, i);
    }
  }
  return capped;
}

function isCodeIntent(query: string): boolean {
  return CODE_INTENT_RE.test(query);
}

function applyCodeBias(results: UnifiedResult[], enabled: boolean): UnifiedResult[] {
  if (!enabled || results.length === 0) return results;
  const boosted = results.map((r) => {
    if (r.retrieval_source !== "rag") return r;
    if (r.has_code || (r.code_signal_count ?? 0) > 0) {
      return { ...r, score: r.score * 1.15 };
    }
    if ((r.artifact_kind ?? "") === "docs") {
      return { ...r, score: r.score * 1.03 };
    }
    return r;
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

function bucketizeCoderResults(results: UnifiedResult[], topK: number, enabled: boolean): UnifiedResult[] {
  if (!enabled || results.length === 0) return results;
  const primaryTarget = Math.max(1, Math.floor(topK * 0.6));
  const primary = results
    .filter((r) => r.retrieval_source === "rag" && (r.has_code || (r.code_signal_count ?? 0) > 0))
    .slice(0, primaryTarget)
    .map((r) => ({ ...r, evidence_bucket: "primary_code" as const }));

  const primaryKeys = new Set(primary.map((r) => `${r.source_url}|${r.heading_path}|${r.text.slice(0, 120)}`));
  const supporting = results
    .filter((r) => !primaryKeys.has(`${r.source_url}|${r.heading_path}|${r.text.slice(0, 120)}`))
    .slice(0, Math.max(0, topK - primary.length))
    .map((r) => ({ ...r, evidence_bucket: "supporting_docs" as const }));

  return [...primary, ...supporting];
}

// ---------------------------------------------------------------------------
// Phase 3b: Domain policy
// ---------------------------------------------------------------------------

function preferredDomainBoost(
  webResults: UnifiedResult[],
  preferredDomains: string[],
  boost: number,
): UnifiedResult[] {
  if (preferredDomains.length === 0) return webResults;
  const patterns = preferredDomains.map((d) => d.replace(/^site:/, "").toLowerCase());

  return webResults.map((r) => {
    const url = (r.source_url ?? "").toLowerCase();
    const matches = patterns.some((p) => url.includes(p));
    return matches ? { ...r, score: r.score * boost } : r;
  });
}

function restrictDomainFilter(
  webResults: UnifiedResult[],
  preferredDomains: string[],
): UnifiedResult[] {
  if (preferredDomains.length === 0) return webResults;
  const patterns = preferredDomains.map((d) => d.replace(/^site:/, "").toLowerCase());

  return webResults.filter((r) => {
    const url = (r.source_url ?? "").toLowerCase();
    return patterns.some((p) => url.includes(p));
  });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

function scaledWebBudget(difficulty: number, base: number, max: number): number {
  return Math.min(Math.round(base + difficulty * (max - base)), max);
}

export async function retrieveUnified(
  request: UnifiedRetrievalRequest,
  settings: RetrievalSettings,
): Promise<RetrievalBundle> {
  const {
    query,
    difficulty = 0.5,
    collections = ["synesis_catalog"],
    topK = 8,
    webQuery = "",
    forceWeb = false,
    domainHints = [],
    skipWeb = false,
    preferredDomains = [],
    preseededLock,
    callerOrgId,
    callerTenantIds,
    callerAclGroups,
    callerUserId,
    callerConversationId,
    sourceSurface = "planner_internal",
    toolName = "planner_web_retrieval",
    requestId,
    sessionKey,
    traceId,
  } = request;

  const t0 = performance.now();
  const codeIntent = isCodeIntent(query);
  let ragDegraded = false;
  let webDegraded = false;
  const degradationNotes: string[] = [];

  const webBudget = scaledWebBudget(difficulty, settings.webBudgetBase, settings.webBudgetMax);
  const webEnabled = settings.web.enabled && (webBudget > 0 || forceWeb) && !skipWeb;

  const overfetch = Math.floor(
    settings.overfetchMin + difficulty * (settings.overfetchMax - settings.overfetchMin),
  );

  // Phase 1: Parallel RAG + web
  const ragPromise = retrieveContext(query, settings.rag, {
    collections,
    topK: overfetch,
    scopeFilter: { callerOrgId, callerTenantIds, callerAclGroups, callerUserId, callerConversationId },
  }).catch((err) => {
    ragDegraded = true;
    degradationNotes.push(`RAG failed: ${err instanceof Error ? err.message : String(err)}`);
    return [] as RagResult[];
  });

  let webPromise: Promise<SearchResult[]> | null = null;
  if (webEnabled) {
    const effectiveWebQuery = webQuery || query.slice(0, 120);
    webPromise = searchAndProcess(effectiveWebQuery, settings.web, {
      attribution: {
        source_surface: sourceSurface,
        tool_name: toolName,
        request_id: requestId,
        session_key: sessionKey,
        conversation_id: callerConversationId,
        trace_id: traceId,
        caller_org_id: callerOrgId,
        caller_user_id: callerUserId,
        caller_tenant_ids: callerTenantIds,
      },
    }).catch((err) => {
      webDegraded = true;
      degradationNotes.push(`Web failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SearchResult[];
    });
  }

  const ragResults = await ragPromise;
  const phase1Ms = performance.now() - t0;

  let webResults: SearchResult[] = [];
  if (webPromise) {
    try {
      webResults = await Promise.race([
        webPromise,
        new Promise<SearchResult[]>((resolve) => setTimeout(() => resolve([]), WEB_GRACE_MS)),
      ]);
    } catch {
      webDegraded = true;
    }
  }

  // Phase 2: Map to UnifiedResult
  const ragUnified = ragToUnified(ragResults);
  let webUnified = webToUnified(webResults);

  // Phase 3: L-RAG adaptive web gating
  if (ragUnified.length >= MIN_RAG_FOR_GATING) {
    const maxWeb = Math.max(2, Math.floor(topK / 3));
    webUnified = webUnified.slice(0, maxWeb);
  } else {
    webUnified = webUnified.slice(0, topK);
  }

  // Phase 3b: Domain policy on web results
  if (preferredDomains.length > 0 && webUnified.length > 0) {
    if (settings.domainPolicyMode === "restrict") {
      webUnified = restrictDomainFilter(webUnified, preferredDomains);
    } else {
      webUnified = preferredDomainBoost(webUnified, preferredDomains, settings.domainPolicyBoost);
    }
  }

  // Phase 4: RRF merge
  let merged = rrfMerge(ragUnified, webUnified, settings.rrfK);

  // Phase 4b: Taxonomy domain hint boost
  merged = taxonomyBoost(merged, domainHints);

  // Phase 4c: Freshness boost (soft preference)
  merged = freshnessBoost(merged, settings.freshnessWeight);
  merged = applyCodeBias(merged, codeIntent);

  // Phase 5: Adaptive top-k
  let final = adaptiveTopK(merged, topK, settings.adaptiveGapMultiplier);
  final = bucketizeCoderResults(final, topK, codeIntent);

  // Phase 5b–5d: Cohesion lock pipeline
  let cohesionLock: CohesionLockData | null = null;
  let phase5bMs = 0;
  if (settings.cohesion.enabled && final.length >= settings.cohesion.minResults) {
    const t5b = performance.now();

    if (preseededLock) {
      cohesionLock = preseededLock;
    } else {
      cohesionLock = await detectCohesionLock(final, 3);
    }

    if (cohesionLock) {
      const preCount = final.length;
      const filtered = await cohesionFilter(final, cohesionLock, settings.cohesion);

      if (filtered.length / preCount < 0.2 && preCount >= 5) {
        degradationNotes.push("Cohesion filter too aggressive — reverted");
      } else {
        final = await compressToCohesion(filtered, cohesionLock, settings.cohesion);
      }
    }
    phase5bMs = performance.now() - t5b;
  }

  const totalMs = performance.now() - t0;

  return {
    results: final,
    cohesion_lock: cohesionLock,
    rag_degraded: ragDegraded,
    web_degraded: webDegraded,
    degradation_notes: degradationNotes.join("; "),
    phase_timings: {
      phase1_rag_web_ms: Math.round(phase1Ms * 10) / 10,
      phase5b_cohesion_ms: Math.round(phase5bMs * 10) / 10,
      total_ms: Math.round(totalMs * 10) / 10,
    },
  };
}
