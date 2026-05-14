/**
 * Decision snapshot — consolidates per-request decision context from the
 * orchestrator, recall engine, verification loop, policy engine, and reduction
 * pipeline into a single structure for trace enrichment.
 */

import type { OrchestratorDecision } from "../orchestration/phase-model-orchestrator.js";
import type { RecallDecision } from "../recall/types.js";
import type { VerificationLoopState } from "../verification/types.js";
import type { ExecutionGovernorDecision } from "../governance/execution-governor.js";

export interface GovernorTelemetrySnapshot {
  pause: boolean;
  reason: string | null;
  matchedRules: string[];
  telemetry: ExecutionGovernorDecision["telemetry"];
  chatStateSummary?: Record<string, unknown>;
  fileStateSummary?: Record<string, unknown>;
}

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
  evidencePrefetchLatencyMs?: number;
  evidenceQuality?: Record<string, unknown>;
  languages?: string[];
  isStreaming: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governor?: GovernorTelemetrySnapshot;
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
  evidencePrefetchLatencyMs?: number;
  evidenceQuality?: Record<string, unknown>;
  languages?: string[];
  isStreaming: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: ExecutionGovernorDecision | null;
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
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
    evidencePrefetchLatencyMs: inputs.evidencePrefetchLatencyMs,
    evidenceQuality: inputs.evidenceQuality,
    languages: inputs.languages,
    isStreaming: inputs.isStreaming,
    sensemakingTriggered: inputs.sensemakingTriggered,
    sensemakingReason: inputs.sensemakingReason,
    governor: inputs.governorDecision ? {
      pause: inputs.governorDecision.pause,
      reason: inputs.governorDecision.reason || null,
      matchedRules: inputs.governorDecision.matchedRules,
      telemetry: inputs.governorDecision.telemetry,
      chatStateSummary: inputs.governorChatStateSummary,
      fileStateSummary: inputs.governorFileStateSummary,
    } : undefined,
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
      evidencePrefetchLatencyMs: snapshot.evidencePrefetchLatencyMs,
      evidenceQuality: snapshot.evidenceQuality,
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
      governorPause: snapshot.governor?.pause,
      governorRules: snapshot.governor?.matchedRules,
      governorReason: snapshot.governor?.reason,
      ...(snapshot.governor?.chatStateSummary
        ? { governorChatState: snapshot.governor.chatStateSummary }
        : {}),
      ...(snapshot.governor?.fileStateSummary
        ? { governorFileState: snapshot.governor.fileStateSummary }
        : {}),
    }],
    trace_context: {
      phase: snapshot.phase,
      reducedToolResults: snapshot.reducedToolResults,
      tokensSavedByReduction: snapshot.tokensSavedByReduction,
      languages: snapshot.languages,
      governorTelemetry: snapshot.governor?.telemetry,
      ...(snapshot.governor?.chatStateSummary
        ? { governorChatState: snapshot.governor.chatStateSummary }
        : {}),
      ...(snapshot.governor?.fileStateSummary
        ? { governorFileState: snapshot.governor.fileStateSummary }
        : {}),
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
