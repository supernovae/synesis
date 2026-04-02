/**
 * Decision snapshot — consolidates per-request decision context from the
 * orchestrator, recall engine, verification loop, policy engine, and reduction
 * pipeline into a single structure for trace enrichment.
 */
export function buildDecisionSnapshot(inputs) {
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
export function snapshotToTraceFields(snapshot) {
    return {
        evidence_summary: {
            recallRouting: snapshot.recallRouting,
            recallConfidence: snapshot.recallConfidence,
            evidenceConfidence: snapshot.evidenceConfidence,
            evidenceAuthoritative: snapshot.evidenceAuthoritative,
            evidencePrefetched: snapshot.evidencePrefetched,
            evidencePrefetchLatencyMs: snapshot.evidencePrefetchLatencyMs,
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
