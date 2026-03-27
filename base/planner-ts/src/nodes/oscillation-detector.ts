import type { GraphState } from "../state/types.js";

const STYLE_WEIGHT = 0.2;
const DECISION_WEIGHT = 0.25;
const RETRIEVAL_WEIGHT = 0.1;
const CHURN_WEIGHT = 0.2;
const OVERRIDE_WEIGHT = 0.05;
const CONTENT_DRIFT_WEIGHT = 0.2;

export interface OscillationReport {
  style_score: number;
  decision_score: number;
  retrieval_score: number;
  section_churn: number;
  content_drift: number;
  unsupported_overrides: number;
  total_score: number;
}

function scoreStyleOscillation(state: GraphState): number {
  const contract = state.style_contract_locked ?? {};
  const draft = state.generated_code ?? "";
  if (!contract || draft.length === 0) return 0;
  const wantsDirect = Boolean(contract.direct_answer_first ?? true);
  if (!wantsDirect) return 0;
  const firstParagraph = draft.trim().split("\n\n")[0]?.toLowerCase() ?? "";
  const preambleMarkers = ["before we begin", "let me start by", "in this response", "let's first"];
  return preambleMarkers.some((marker) => firstParagraph.includes(marker)) ? 0.5 : 0;
}

function scoreDecisionOscillation(state: GraphState): number {
  const overrideLog = state.override_log ?? [];
  if (overrideLog.length < 2) return 0;
  const counts = new Map<string, number>();
  for (const entry of overrideLog) {
    const decisionId = String(entry.target_decision_id ?? "");
    if (!decisionId) continue;
    counts.set(decisionId, (counts.get(decisionId) ?? 0) + 1);
  }
  const maxFlips = Math.max(0, ...counts.values());
  if (maxFlips >= 3) return 1.0;
  if (maxFlips >= 2) return 0.6;
  return 0;
}

function scoreRetrievalOscillation(state: GraphState): number {
  const spans = state._span_collector?.getSpans() ?? [];
  const routerPasses = spans.filter((s) => s.node_name === "router").length;
  if (routerPasses >= 3) return Math.min(1, routerPasses * 0.25);
  if (routerPasses >= 2) return 0.3;
  return state.need_more_evidence ? 0.2 : 0;
}

function scoreSectionChurn(state: GraphState): number {
  const fingerprints = state.draft_fingerprints ?? [];
  if (fingerprints.length < 2) return 0;
  let changes = 0;
  for (let i = 1; i < fingerprints.length; i += 1) {
    if (fingerprints[i] !== fingerprints[i - 1]) changes += 1;
  }
  if (changes === 0) return 0;
  const register = state.critique_register ?? {};
  const critiqueDriven = Object.values(register).length;
  if (changes > 0 && critiqueDriven === 0) return Math.min(1, changes * 0.4);
  if (changes > critiqueDriven * 2) return Math.min(1, (changes - critiqueDriven) * 0.2);
  return 0;
}

function scoreContentDrift(state: GraphState): number {
  const draft = state.generated_code ?? "";
  const fingerprints = state.draft_fingerprints ?? [];
  if (draft.length === 0 || fingerprints.length < 2) return 0;
  const h1Matches = Array.from(draft.matchAll(/^#\s+(.+)$/gm)).map((m) => (m[1] ?? "").trim().toLowerCase());
  if (h1Matches.length > 1) {
    const unique = new Set(h1Matches);
    if (unique.size < h1Matches.length) return 1;
  }
  const allUnique = new Set(fingerprints).size === fingerprints.length;
  if (!allUnique) return 0;
  return fingerprints.length >= 3 ? 0.5 : 0;
}

function countUnsupportedOverrides(state: GraphState): number {
  const overrideLog = state.override_log ?? [];
  return overrideLog.filter((entry) => !entry.approved || String(entry.override_reason ?? "").trim().length === 0).length;
}

export function detectOscillation(state: GraphState): OscillationReport {
  const style_score = scoreStyleOscillation(state);
  const decision_score = scoreDecisionOscillation(state);
  const retrieval_score = scoreRetrievalOscillation(state);
  const section_churn = scoreSectionChurn(state);
  const content_drift = scoreContentDrift(state);
  const unsupported_overrides = countUnsupportedOverrides(state);
  const overrideScore = Math.min(1, unsupported_overrides * 0.3);

  const total_score =
    STYLE_WEIGHT * style_score +
    DECISION_WEIGHT * decision_score +
    RETRIEVAL_WEIGHT * retrieval_score +
    CHURN_WEIGHT * section_churn +
    CONTENT_DRIFT_WEIGHT * content_drift +
    OVERRIDE_WEIGHT * overrideScore;

  return {
    style_score,
    decision_score,
    retrieval_score,
    section_churn,
    content_drift,
    unsupported_overrides,
    total_score
  };
}
