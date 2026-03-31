/**
 * Decision snapshot — consolidates per-request decision context from the
 * orchestrator, recall engine, verification loop, policy engine, and reduction
 * pipeline into a single structure for trace enrichment.
 */

import type { OrchestratorDecision } from "../orchestration/phase-model-orchestrator.js";
import type { RecallDecision } from "../recall/types.js";
import type { VerificationLoopState } from "../verification/types.js";

export interface DecisionSnapshot {
  decisionPath: string;
  phase: string;
  tier: string;
  escalated: boolean;
  escalationReason?: string;
  recallRouting?: string;
  recallConfidence?: number;
  verificationRound?: number;
  verificationStalled?: boolean;
  verificationFindings?: number;
  policyDecision: string;
  reducedToolResults: number;
  tokensSavedByReduction: number;
  evidencePrefetched?: boolean;
  evidenceConfidence?: number;
  evidenceAuthoritative?: boolean;
  languages?: string[];
  isStreaming: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
}

export interface SnapshotInputs {
  orchestration: OrchestratorDecision;
  recallDecision: RecallDecision | null;
  verificationState: VerificationLoopState;
  policyMatchedRules: string[];
  reducedToolResults: number;
  tokensSavedByReduction: number;
  evidencePrefetched?: boolean;
  evidenceConfidence?: number;
  evidenceAuthoritative?: boolean;
  languages?: string[];
  isStreaming: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
}

export function buildDecisionSnapshot(inputs: SnapshotInputs): DecisionSnapshot {
  const { orchestration, recallDecision, verificationState } = inputs;

  return {
    decisionPath: orchestration.decisionPath,
    phase: orchestration.phase,
    tier: orchestration.tier,
    escalated: orchestration.escalated,
    escalationReason: orchestration.escalationReason,
    recallRouting: recallDecision?.routing,
    recallConfidence: recallDecision?.resolution?.confidence,
    verificationRound: verificationState.round > 0 ? verificationState.round : undefined,
    verificationStalled: verificationState.stalled || undefined,
    verificationFindings: verificationState.round > 0 ? verificationState.findings.length : undefined,
    policyDecision: inputs.policyMatchedRules.join(","),
    reducedToolResults: inputs.reducedToolResults,
    tokensSavedByReduction: inputs.tokensSavedByReduction,
    evidencePrefetched: inputs.evidencePrefetched,
    evidenceConfidence: inputs.evidenceConfidence,
    evidenceAuthoritative: inputs.evidenceAuthoritative,
    languages: inputs.languages,
    isStreaming: inputs.isStreaming,
    sensemakingTriggered: inputs.sensemakingTriggered,
    sensemakingReason: inputs.sensemakingReason,
  };
}

/**
 * Map a DecisionSnapshot onto the existing TraceRecord optional fields.
 * Returns partial fields to spread into the TraceRecord.
 */
export function snapshotToTraceFields(snapshot: DecisionSnapshot): {
  evidence_summary: Record<string, unknown>;
  decision_ledger: unknown[];
  trace_context: Record<string, unknown>;
  streaming: { mode: "streaming" | "non-streaming" };
  taxonomy: Record<string, unknown>;
  is_code_task: boolean;
} {
  return {
    evidence_summary: {
      recallRouting: snapshot.recallRouting,
      recallConfidence: snapshot.recallConfidence,
      evidenceConfidence: snapshot.evidenceConfidence,
      evidenceAuthoritative: snapshot.evidenceAuthoritative,
      evidencePrefetched: snapshot.evidencePrefetched,
      verificationRound: snapshot.verificationRound,
      verificationStalled: snapshot.verificationStalled,
      verificationFindings: snapshot.verificationFindings,
      sensemakingTriggered: snapshot.sensemakingTriggered,
      sensemakingReason: snapshot.sensemakingReason,
    },
    decision_ledger: [{
      path: snapshot.decisionPath,
      tier: snapshot.tier,
      escalated: snapshot.escalated,
      escalationReason: snapshot.escalationReason,
      policyDecision: snapshot.policyDecision,
    }],
    trace_context: {
      phase: snapshot.phase,
      reducedToolResults: snapshot.reducedToolResults,
      tokensSavedByReduction: snapshot.tokensSavedByReduction,
      languages: snapshot.languages,
    },
    streaming: {
      mode: snapshot.isStreaming ? "streaming" : "non-streaming",
    },
    taxonomy: {
      languages: snapshot.languages,
    },
    is_code_task: true,
  };
}
