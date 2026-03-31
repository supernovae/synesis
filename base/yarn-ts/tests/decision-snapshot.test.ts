import { describe, expect, it } from "vitest";
import {
  buildDecisionSnapshot,
  snapshotToTraceFields,
  type DecisionSnapshot,
  type SnapshotInputs,
} from "../src/telemetry/decision-snapshot.js";
import type { OrchestratorDecision } from "../src/orchestration/phase-model-orchestrator.js";
import type { RecallDecision } from "../src/recall/types.js";
import type { VerificationLoopState } from "../src/verification/types.js";

function makeOrchestration(overrides: Partial<OrchestratorDecision> = {}): OrchestratorDecision {
  return {
    selectedModel: "synesis-core",
    phase: "implementation",
    tier: "synesis-core",
    decisionPath: "inference_first",
    maxOutputTokens: 8192,
    reasons: ["default"],
    escalated: false,
    ...overrides,
  };
}

function makeRecallDecision(overrides: Partial<RecallDecision> = {}): RecallDecision {
  return {
    routing: "passthrough",
    resolution: null,
    syntheticBlock: null,
    enrichmentBlock: null,
    ...overrides,
  };
}

function emptyVerificationState(): VerificationLoopState {
  return {
    round: 0,
    findings: [],
    allResolved: false,
    stalled: false,
    budgetExhausted: false,
    history: [],
  };
}

function activeVerificationState(round = 2, stalled = false, findingCount = 3): VerificationLoopState {
  const findings = Array.from({ length: findingCount }, (_, i) => ({
    role: "tool" as const,
    toolCallId: `tc-${i}`,
    toolName: "build",
    content: `error ${i}`,
    normalizedContent: `error ${i}`,
    validationFamily: "typescript" as const,
    reducedContent: `err${i}`,
    tokenDelta: 10,
    structured: [],
  }));
  return {
    round,
    findings,
    allResolved: false,
    stalled,
    budgetExhausted: false,
    history: [],
  };
}

function baseInputs(overrides: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return {
    orchestration: makeOrchestration(),
    recallDecision: null,
    verificationState: emptyVerificationState(),
    policyMatchedRules: [],
    reducedToolResults: 0,
    tokensSavedByReduction: 0,
    isStreaming: false,
    ...overrides,
  };
}

describe("Decision Snapshot — buildDecisionSnapshot", () => {
  it("produces a snapshot with minimal inputs (no recall, no verification)", () => {
    const snap = buildDecisionSnapshot(baseInputs());
    expect(snap.decisionPath).toBe("inference_first");
    expect(snap.phase).toBe("implementation");
    expect(snap.tier).toBe("synesis-core");
    expect(snap.escalated).toBe(false);
    expect(snap.escalationReason).toBeUndefined();
    expect(snap.recallRouting).toBeUndefined();
    expect(snap.recallConfidence).toBeUndefined();
    expect(snap.verificationRound).toBeUndefined();
    expect(snap.verificationStalled).toBeUndefined();
    expect(snap.verificationFindings).toBeUndefined();
    expect(snap.policyDecision).toBe("");
    expect(snap.reducedToolResults).toBe(0);
    expect(snap.tokensSavedByReduction).toBe(0);
    expect(snap.isStreaming).toBe(false);
  });

  it("captures recall decision when present", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      recallDecision: makeRecallDecision({
        routing: "enrich",
        resolution: {
          confidence: 0.72,
          resolvedFindings: [],
          resolvedCount: 1,
          totalFindings: 2,
        },
      }),
    }));
    expect(snap.recallRouting).toBe("enrich");
    expect(snap.recallConfidence).toBe(0.72);
  });

  it("captures recall bypass routing", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      recallDecision: makeRecallDecision({
        routing: "bypass",
        resolution: { confidence: 0.95, resolvedFindings: [], resolvedCount: 1, totalFindings: 1 },
        syntheticBlock: "## Fix\nUse strict mode",
      }),
    }));
    expect(snap.recallRouting).toBe("bypass");
    expect(snap.recallConfidence).toBe(0.95);
  });

  it("captures active verification state", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      verificationState: activeVerificationState(3, false, 5),
    }));
    expect(snap.verificationRound).toBe(3);
    expect(snap.verificationStalled).toBeUndefined();
    expect(snap.verificationFindings).toBe(5);
  });

  it("captures stalled verification", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      verificationState: activeVerificationState(2, true, 4),
    }));
    expect(snap.verificationRound).toBe(2);
    expect(snap.verificationStalled).toBe(true);
    expect(snap.verificationFindings).toBe(4);
  });

  it("omits verification when round is 0", () => {
    const snap = buildDecisionSnapshot(baseInputs());
    expect(snap.verificationRound).toBeUndefined();
    expect(snap.verificationFindings).toBeUndefined();
  });

  it("captures escalation details", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      orchestration: makeOrchestration({
        escalated: true,
        escalationReason: "high risk + stalled verification",
        tier: "synesis-horizon",
        decisionPath: "inference_first",
      }),
    }));
    expect(snap.escalated).toBe(true);
    expect(snap.escalationReason).toBe("high risk + stalled verification");
    expect(snap.tier).toBe("synesis-horizon");
  });

  it("joins policy matched rules", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      policyMatchedRules: ["no-secrets", "tool-loop-limit"],
    }));
    expect(snap.policyDecision).toBe("no-secrets,tool-loop-limit");
  });

  it("captures reduction stats", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      reducedToolResults: 5,
      tokensSavedByReduction: 1200,
    }));
    expect(snap.reducedToolResults).toBe(5);
    expect(snap.tokensSavedByReduction).toBe(1200);
  });

  it("captures streaming flag", () => {
    const streaming = buildDecisionSnapshot(baseInputs({ isStreaming: true }));
    expect(streaming.isStreaming).toBe(true);

    const nonStreaming = buildDecisionSnapshot(baseInputs({ isStreaming: false }));
    expect(nonStreaming.isStreaming).toBe(false);
  });

  it("captures evidence prefetch fields", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      evidencePrefetched: true,
      evidenceConfidence: 0.88,
      evidenceAuthoritative: true,
    }));
    expect(snap.evidencePrefetched).toBe(true);
    expect(snap.evidenceConfidence).toBe(0.88);
    expect(snap.evidenceAuthoritative).toBe(true);
  });

  it("captures languages array", () => {
    const snap = buildDecisionSnapshot(baseInputs({
      languages: ["typescript", "go"],
    }));
    expect(snap.languages).toEqual(["typescript", "go"]);
  });

  it("handles all fields populated simultaneously", () => {
    const snap = buildDecisionSnapshot({
      orchestration: makeOrchestration({
        decisionPath: "deterministic",
        phase: "validation",
        tier: "synesis-pulse",
        escalated: false,
      }),
      recallDecision: makeRecallDecision({
        routing: "bypass",
        resolution: { confidence: 0.98, resolvedFindings: [], resolvedCount: 1, totalFindings: 1 },
        syntheticBlock: "fix",
      }),
      verificationState: activeVerificationState(1, false, 2),
      policyMatchedRules: ["allowed"],
      reducedToolResults: 3,
      tokensSavedByReduction: 500,
      evidencePrefetched: true,
      evidenceConfidence: 0.91,
      evidenceAuthoritative: true,
      languages: ["rust"],
      isStreaming: true,
    });
    expect(snap.decisionPath).toBe("deterministic");
    expect(snap.phase).toBe("validation");
    expect(snap.tier).toBe("synesis-pulse");
    expect(snap.recallRouting).toBe("bypass");
    expect(snap.recallConfidence).toBe(0.98);
    expect(snap.verificationRound).toBe(1);
    expect(snap.verificationFindings).toBe(2);
    expect(snap.policyDecision).toBe("allowed");
    expect(snap.reducedToolResults).toBe(3);
    expect(snap.tokensSavedByReduction).toBe(500);
    expect(snap.evidencePrefetched).toBe(true);
    expect(snap.evidenceConfidence).toBe(0.91);
    expect(snap.evidenceAuthoritative).toBe(true);
    expect(snap.languages).toEqual(["rust"]);
    expect(snap.isStreaming).toBe(true);
  });
});

describe("Decision Snapshot — snapshotToTraceFields", () => {
  function snap(overrides: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
    return {
      decisionPath: "inference_first",
      phase: "implementation",
      tier: "synesis-core",
      escalated: false,
      policyDecision: "",
      reducedToolResults: 0,
      tokensSavedByReduction: 0,
      isStreaming: false,
      ...overrides,
    };
  }

  it("returns all required trace fields", () => {
    const fields = snapshotToTraceFields(snap());
    expect(fields).toHaveProperty("evidence_summary");
    expect(fields).toHaveProperty("decision_ledger");
    expect(fields).toHaveProperty("trace_context");
    expect(fields).toHaveProperty("streaming");
    expect(fields).toHaveProperty("taxonomy");
    expect(fields).toHaveProperty("is_code_task");
  });

  it("evidence_summary contains recall and verification data", () => {
    const fields = snapshotToTraceFields(snap({
      recallRouting: "enrich",
      recallConfidence: 0.65,
      evidenceConfidence: 0.77,
      evidenceAuthoritative: false,
      evidencePrefetched: true,
      verificationRound: 2,
      verificationStalled: true,
      verificationFindings: 4,
    }));
    const es = fields.evidence_summary;
    expect(es.recallRouting).toBe("enrich");
    expect(es.recallConfidence).toBe(0.65);
    expect(es.evidenceConfidence).toBe(0.77);
    expect(es.evidenceAuthoritative).toBe(false);
    expect(es.evidencePrefetched).toBe(true);
    expect(es.verificationRound).toBe(2);
    expect(es.verificationStalled).toBe(true);
    expect(es.verificationFindings).toBe(4);
  });

  it("decision_ledger contains path, tier, escalation", () => {
    const fields = snapshotToTraceFields(snap({
      decisionPath: "constrained",
      tier: "synesis-horizon",
      escalated: true,
      escalationReason: "high risk",
      policyDecision: "tool-loop-limit",
    }));
    expect(fields.decision_ledger).toHaveLength(1);
    const entry = fields.decision_ledger[0] as Record<string, unknown>;
    expect(entry.path).toBe("constrained");
    expect(entry.tier).toBe("synesis-horizon");
    expect(entry.escalated).toBe(true);
    expect(entry.escalationReason).toBe("high risk");
    expect(entry.policyDecision).toBe("tool-loop-limit");
  });

  it("trace_context contains phase, reduction stats, languages", () => {
    const fields = snapshotToTraceFields(snap({
      phase: "validation",
      reducedToolResults: 7,
      tokensSavedByReduction: 2000,
      languages: ["python", "java"],
    }));
    expect(fields.trace_context.phase).toBe("validation");
    expect(fields.trace_context.reducedToolResults).toBe(7);
    expect(fields.trace_context.tokensSavedByReduction).toBe(2000);
    expect(fields.trace_context.languages).toEqual(["python", "java"]);
  });

  it("streaming field reflects mode correctly", () => {
    const streamFields = snapshotToTraceFields(snap({ isStreaming: true }));
    expect(streamFields.streaming.mode).toBe("streaming");

    const nonStreamFields = snapshotToTraceFields(snap({ isStreaming: false }));
    expect(nonStreamFields.streaming.mode).toBe("non-streaming");
  });

  it("taxonomy contains languages", () => {
    const fields = snapshotToTraceFields(snap({ languages: ["go"] }));
    expect(fields.taxonomy.languages).toEqual(["go"]);
  });

  it("is_code_task is always true for Yarn traces", () => {
    const fields = snapshotToTraceFields(snap());
    expect(fields.is_code_task).toBe(true);
  });

  it("handles undefined optional fields gracefully", () => {
    const fields = snapshotToTraceFields(snap());
    expect(fields.evidence_summary.recallRouting).toBeUndefined();
    expect(fields.evidence_summary.recallConfidence).toBeUndefined();
    expect(fields.evidence_summary.verificationRound).toBeUndefined();
    expect(fields.trace_context.languages).toBeUndefined();
  });

  it("decision_ledger omits escalationReason when not escalated", () => {
    const fields = snapshotToTraceFields(snap({ escalated: false }));
    const entry = fields.decision_ledger[0] as Record<string, unknown>;
    expect(entry.escalated).toBe(false);
    expect(entry.escalationReason).toBeUndefined();
  });
});

describe("Decision Snapshot — deterministic path snapshot", () => {
  it("captures full deterministic bypass flow", () => {
    const snap = buildDecisionSnapshot({
      orchestration: makeOrchestration({
        decisionPath: "deterministic",
        phase: "implementation",
        tier: "synesis-pulse",
        escalated: false,
      }),
      recallDecision: makeRecallDecision({
        routing: "bypass",
        resolution: { confidence: 0.97, resolvedFindings: [], resolvedCount: 2, totalFindings: 2 },
        syntheticBlock: "## Deterministic fix\nAdd missing semicolons",
      }),
      verificationState: emptyVerificationState(),
      policyMatchedRules: [],
      reducedToolResults: 0,
      tokensSavedByReduction: 0,
      isStreaming: false,
    });

    expect(snap.decisionPath).toBe("deterministic");
    expect(snap.recallRouting).toBe("bypass");
    expect(snap.recallConfidence).toBe(0.97);

    const fields = snapshotToTraceFields(snap);
    expect(fields.evidence_summary.recallRouting).toBe("bypass");
    expect(fields.evidence_summary.recallConfidence).toBe(0.97);
    const entry = fields.decision_ledger[0] as Record<string, unknown>;
    expect(entry.path).toBe("deterministic");
    expect(entry.tier).toBe("synesis-pulse");
  });
});

describe("Decision Snapshot — abstain path snapshot", () => {
  it("captures abstain with uncertainty framing", () => {
    const snap = buildDecisionSnapshot({
      orchestration: makeOrchestration({
        decisionPath: "abstain",
        phase: "implementation",
        tier: "synesis-core",
        escalated: false,
        uncertaintyFraming: "Evidence is insufficient for this task.",
      }),
      recallDecision: makeRecallDecision({ routing: "passthrough" }),
      verificationState: emptyVerificationState(),
      policyMatchedRules: [],
      reducedToolResults: 0,
      tokensSavedByReduction: 0,
      isStreaming: true,
    });

    expect(snap.decisionPath).toBe("abstain");
    expect(snap.recallRouting).toBe("passthrough");

    const fields = snapshotToTraceFields(snap);
    const entry = fields.decision_ledger[0] as Record<string, unknown>;
    expect(entry.path).toBe("abstain");
  });
});

describe("Decision Snapshot — escalation scenario snapshot", () => {
  it("captures escalation from stalled verification", () => {
    const snap = buildDecisionSnapshot({
      orchestration: makeOrchestration({
        decisionPath: "inference_first",
        phase: "validation",
        tier: "synesis-horizon",
        escalated: true,
        escalationReason: "stalled_verification",
      }),
      recallDecision: makeRecallDecision({ routing: "enrich" }),
      verificationState: activeVerificationState(3, true, 6),
      policyMatchedRules: ["tool-loop-limit"],
      reducedToolResults: 2,
      tokensSavedByReduction: 300,
      isStreaming: false,
    });

    expect(snap.escalated).toBe(true);
    expect(snap.escalationReason).toBe("stalled_verification");
    expect(snap.verificationRound).toBe(3);
    expect(snap.verificationStalled).toBe(true);
    expect(snap.verificationFindings).toBe(6);

    const fields = snapshotToTraceFields(snap);
    expect(fields.evidence_summary.verificationStalled).toBe(true);
    const entry = fields.decision_ledger[0] as Record<string, unknown>;
    expect(entry.escalated).toBe(true);
    expect(entry.escalationReason).toBe("stalled_verification");
  });
});
