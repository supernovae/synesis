import { describe, expect, it } from "vitest";
import { analyzeGaps, shouldTriggerSensemaking } from "../src/sensemaking/gap-analyzer.js";
import { buildExplorationPlan } from "../src/sensemaking/exploration-planner.js";
import { formatExplorationPlanBlock } from "../src/sensemaking/formatter.js";
import { createEmptySensemakingStats } from "../src/sensemaking/types.js";
import type { GapAnalysisContext, SensemakingResult } from "../src/sensemaking/types.js";
import type { OrchestratorDecision } from "../src/orchestration/phase-model-orchestrator.js";
import type { RecallDecision } from "../src/recall/types.js";
import type { VerificationLoopState } from "../src/verification/types.js";

function makeDecision(overrides: Partial<OrchestratorDecision> = {}): OrchestratorDecision {
  return {
    selectedModel: "synesis-core",
    phase: "implementation",
    tier: "synesis-core",
    decisionPath: "inference_first",
    maxOutputTokens: 2800,
    reasons: ["default"],
    escalated: false,
    ...overrides,
  };
}

function emptyVerifState(): VerificationLoopState {
  return { round: 0, findings: [], allResolved: false, stalled: false, budgetExhausted: false, history: [] };
}

function stalledVerifState(round = 2, findingCount = 3): VerificationLoopState {
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
  return { round, findings, allResolved: false, stalled: true, budgetExhausted: false, history: [] };
}

function resolvedVerifState(): VerificationLoopState {
  return { round: 1, findings: [], allResolved: true, stalled: false, budgetExhausted: false, history: [] };
}

function baseContext(overrides: Partial<GapAnalysisContext> = {}): GapAnalysisContext {
  return {
    recallDecision: null,
    verificationState: emptyVerifState(),
    phase: "implementation",
    decisionPath: "inference_first",
    consecutiveFailedVerifications: 0,
    languages: [],
    userText: "Fix the type error in auth.ts",
    ...overrides,
  };
}

function makeRecall(overrides: Partial<RecallDecision> = {}): RecallDecision {
  return {
    routing: "passthrough",
    resolution: null,
    syntheticBlock: null,
    enrichmentBlock: null,
    ...overrides,
  };
}

// ========================================
// Gap Analyzer
// ========================================

describe("Gap Analyzer — analyzeGaps", () => {
  it("classifies no recall as unknown", () => {
    const gaps = analyzeGaps(baseContext());
    expect(gaps.unknown.some((g) => g.domain === "recall")).toBe(true);
  });

  it("classifies passthrough recall as unknown", () => {
    const gaps = analyzeGaps(baseContext({
      recallDecision: makeRecall({ routing: "passthrough" }),
    }));
    expect(gaps.unknown.some((g) => g.domain === "recall")).toBe(true);
  });

  it("classifies high-confidence bypass recall as known", () => {
    const gaps = analyzeGaps(baseContext({
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.92, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    }));
    expect(gaps.known.some((g) => g.domain === "recall")).toBe(true);
    expect(gaps.unknown.filter((g) => g.domain === "recall").length).toBe(0);
  });

  it("classifies moderate-confidence bypass recall as know_better", () => {
    const gaps = analyzeGaps(baseContext({
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.65, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    }));
    expect(gaps.knowBetter.some((g) => g.domain === "recall")).toBe(true);
  });

  it("classifies enrich recall as know_better", () => {
    const gaps = analyzeGaps(baseContext({
      recallDecision: makeRecall({
        routing: "enrich",
        resolution: { confidence: 0.55, findings: [], resolvedCount: 0, totalFindings: 1 },
      }),
    }));
    expect(gaps.knowBetter.some((g) => g.domain === "recall")).toBe(true);
  });

  it("classifies authoritative high-confidence evidence as known", () => {
    const gaps = analyzeGaps(baseContext({
      evidencePrefetched: true,
      evidenceConfidence: 0.9,
      evidenceAuthoritative: true,
    }));
    expect(gaps.known.some((g) => g.domain === "evidence")).toBe(true);
  });

  it("classifies moderate-confidence evidence as know_better", () => {
    const gaps = analyzeGaps(baseContext({
      evidencePrefetched: true,
      evidenceConfidence: 0.6,
      evidenceAuthoritative: false,
    }));
    expect(gaps.knowBetter.some((g) => g.domain === "evidence")).toBe(true);
  });

  it("classifies low-confidence evidence as know_better", () => {
    const gaps = analyzeGaps(baseContext({
      evidencePrefetched: true,
      evidenceConfidence: 0.15,
      evidenceAuthoritative: false,
    }));
    expect(gaps.knowBetter.some((g) => g.domain === "evidence")).toBe(true);
  });

  it("does not classify evidence when not prefetched", () => {
    const gaps = analyzeGaps(baseContext());
    expect(gaps.known.filter((g) => g.domain === "evidence").length).toBe(0);
    expect(gaps.knowBetter.filter((g) => g.domain === "evidence").length).toBe(0);
  });

  it("classifies resolved verification as known", () => {
    const gaps = analyzeGaps(baseContext({
      verificationState: resolvedVerifState(),
    }));
    expect(gaps.known.some((g) => g.domain === "verification")).toBe(true);
  });

  it("classifies stalled verification as know_better", () => {
    const gaps = analyzeGaps(baseContext({
      verificationState: stalledVerifState(),
    }));
    expect(gaps.knowBetter.some((g) => g.domain === "verification")).toBe(true);
  });

  it("classifies no languages as unknown", () => {
    const gaps = analyzeGaps(baseContext({ languages: [] }));
    expect(gaps.unknown.some((g) => g.domain === "language")).toBe(true);
  });

  it("classifies detected languages as known", () => {
    const gaps = analyzeGaps(baseContext({ languages: ["typescript", "go"] }));
    const langKnown = gaps.known.filter((g) => g.domain === "language");
    expect(langKnown.length).toBe(2);
  });
});

// ========================================
// Sensemaking Trigger
// ========================================

describe("Gap Analyzer — shouldTriggerSensemaking", () => {
  it("hard-stop-only mode suppresses routine explore/abstain triggers", () => {
    const gaps = analyzeGaps(baseContext({ languages: [] }));
    const explore = shouldTriggerSensemaking(gaps, makeDecision({ phase: "explore" }), 0, 0.5, true);
    const abstain = shouldTriggerSensemaking(gaps, makeDecision({ decisionPath: "abstain" }), 1, 0.5, true);
    expect(explore.trigger).toBe(false);
    expect(abstain.trigger).toBe(false);
  });

  it("hard-stop-only mode triggers only after severe repeated failures", () => {
    const gaps = analyzeGaps(baseContext({ languages: [] }));
    const result = shouldTriggerSensemaking(
      gaps,
      makeDecision({ decisionPath: "abstain", phase: "validation" }),
      4,
      0.5,
      true,
    );
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe("hard_stop_diagnostics");
  });

  it("triggers on explore phase", () => {
    const gaps = analyzeGaps(baseContext());
    const decision = makeDecision({ phase: "explore" });
    const result = shouldTriggerSensemaking(gaps, decision, 0);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe("explore_phase");
  });

  it("triggers on abstain decision path", () => {
    const gaps = analyzeGaps(baseContext());
    const decision = makeDecision({ decisionPath: "abstain" });
    const result = shouldTriggerSensemaking(gaps, decision, 0);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe("abstain_path");
  });

  it("triggers on repeated verification failures with unknown gaps", () => {
    const gaps = analyzeGaps(baseContext({ languages: [] }));
    const decision = makeDecision();
    const result = shouldTriggerSensemaking(gaps, decision, 3);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe("repeated_verification_failures");
  });

  it("does not trigger on repeated failures without unknown gaps", () => {
    const gaps = analyzeGaps(baseContext({
      languages: ["typescript"],
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    }));
    const decision = makeDecision();
    const result = shouldTriggerSensemaking(gaps, decision, 3);
    expect(result.trigger).toBe(false);
  });

  it("triggers on high know_better ratio", () => {
    const gaps = analyzeGaps(baseContext({
      languages: ["typescript"],
      recallDecision: makeRecall({
        routing: "enrich",
        resolution: { confidence: 0.5, findings: [], resolvedCount: 0, totalFindings: 1 },
      }),
      evidencePrefetched: true,
      evidenceConfidence: 0.4,
      evidenceAuthoritative: false,
      verificationState: stalledVerifState(),
    }));
    const decision = makeDecision();
    const result = shouldTriggerSensemaking(gaps, decision, 0, 0.3);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe("high_know_better_ratio");
  });

  it("does not trigger for normal implementation", () => {
    const gaps = analyzeGaps(baseContext({ languages: ["typescript"] }));
    const decision = makeDecision();
    const result = shouldTriggerSensemaking(gaps, decision, 0);
    expect(result.trigger).toBe(false);
  });
});

// ========================================
// Exploration Planner
// ========================================

describe("Exploration Planner — buildExplorationPlan", () => {
  it("builds a plan from unknown gaps", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);

    expect(plan.desiredEndState).toBeTruthy();
    expect(plan.preconditions.length).toBeGreaterThan(0);
    expect(plan.evidenceCheckpoints.length).toBeGreaterThan(0);
    expect(plan.forwardPath.length).toBeGreaterThan(0);
    expect(plan.fallbackBranches.length).toBeGreaterThan(0);
  });

  it("uses working frame goal as desired end state", () => {
    const ctx = baseContext({ workingFrameGoal: "Fix all TypeScript errors in auth module" });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.desiredEndState).toBe("Fix all TypeScript errors in auth module");
  });

  it("uses user text as fallback for desired end state", () => {
    const ctx = baseContext({ userText: "Refactor the database layer" });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.desiredEndState).toBe("Refactor the database layer");
  });

  it("generates tool actions for unknown language gaps", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const toolActions = plan.forwardPath.filter((a) => a.kind === "tool");
    expect(toolActions.some((a) => a.tool === "synesis_inspect_repo")).toBe(true);
  });

  it("generates search actions for unknown recall gaps", () => {
    const ctx = baseContext({ languages: ["typescript"] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const searchActions = plan.forwardPath.filter((a) => a.kind === "search");
    expect(searchActions.length).toBeGreaterThan(0);
  });

  it("generates verification tool actions for know_better verification gaps", () => {
    const ctx = baseContext({
      languages: ["typescript"],
      verificationState: stalledVerifState(),
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const verifActions = plan.forwardPath.filter((a) => a.tool === "tsc");
    expect(verifActions.length).toBeGreaterThan(0);
  });

  it("generates explore-specific actions when all known and phase is explore", () => {
    const ctx = baseContext({
      phase: "explore",
      languages: ["typescript"],
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.forwardPath.some((a) => a.tool === "synesis_inspect_repo")).toBe(true);
    expect(plan.forwardPath.some((a) => a.tool === "synesis_knowledge_search")).toBe(true);
  });

  it("handles all-known gaps gracefully", () => {
    const ctx = baseContext({
      languages: ["go"],
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
      verificationState: resolvedVerifState(),
      evidencePrefetched: true,
      evidenceConfidence: 0.92,
      evidenceAuthoritative: true,
    });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.preconditions).toContain("All evidence gaps are resolved — proceed with implementation");
    expect(plan.evidenceCheckpoints).toContain("Verify approach against known constraints before generating code");
  });

  it("generates go-specific tool actions", () => {
    const ctx = baseContext({
      languages: ["go"],
      verificationState: stalledVerifState(),
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.forwardPath.some((a) => a.tool === "go-vet")).toBe(true);
  });

  it("generates python-specific tool actions", () => {
    const ctx = baseContext({
      languages: ["python"],
      verificationState: stalledVerifState(),
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.forwardPath.some((a) => a.tool === "ruff")).toBe(true);
  });

  it("generates rust-specific tool actions", () => {
    const ctx = baseContext({
      languages: ["rust"],
      verificationState: stalledVerifState(),
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
    });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    expect(plan.forwardPath.some((a) => a.tool === "cargo-check")).toBe(true);
  });
});

// ========================================
// Formatter
// ========================================

describe("Formatter — formatExplorationPlanBlock", () => {
  it("returns empty string when not triggered", () => {
    const result: SensemakingResult = {
      triggered: false,
      gaps: { known: [], unknown: [], knowBetter: [] },
    };
    expect(formatExplorationPlanBlock(result)).toBe("");
  });

  it("returns empty string when no plan", () => {
    const result: SensemakingResult = {
      triggered: true,
      reason: "explore_phase",
      gaps: { known: [], unknown: [], knowBetter: [] },
    };
    expect(formatExplorationPlanBlock(result)).toBe("");
  });

  it("produces block with EXPLORATION_PLAN tags", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: "explore_phase", gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("<EXPLORATION_PLAN>");
    expect(block).toContain("</EXPLORATION_PLAN>");
    expect(block).toContain("Sensemaking activated");
  });

  it("includes evidence classification summary", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: "abstain_path", gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("Evidence Classification");
    expect(block).toContain("**Unknown**");
  });

  it("includes desired end state", () => {
    const ctx = baseContext({ userText: "Fix auth module" });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: "explore_phase", gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("Desired End State");
    expect(block).toContain("Fix auth module");
  });

  it("includes recommended actions", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: "explore_phase", gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("Recommended Actions");
    expect(block).toContain("IMPORTANT: Execute the exploration actions");
  });

  it("includes fallback strategy", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: "explore_phase", gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("Fallback Strategy");
  });

  it("formats tool actions with tool name", () => {
    const ctx = baseContext({ languages: [] });
    const gaps = analyzeGaps(ctx);
    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: "explore_phase", gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("[synesis_inspect_repo]");
  });
});

// ========================================
// Stats
// ========================================

describe("Sensemaking Stats", () => {
  it("creates empty stats with all zero counters", () => {
    const stats = createEmptySensemakingStats();
    expect(stats.triggeredCount).toBe(0);
    expect(stats.skippedCount).toBe(0);
    expect(stats.plansGenerated).toBe(0);
    expect(stats.actionsGenerated).toBe(0);
    expect(stats.totalGapsClassified).toBe(0);
    expect(stats.knownCount).toBe(0);
    expect(stats.unknownCount).toBe(0);
    expect(stats.knowBetterCount).toBe(0);
    expect(Object.keys(stats.byReason).length).toBe(0);
  });
});

// ========================================
// End-to-end scenarios
// ========================================

describe("Sensemaking — end-to-end scenarios", () => {
  it("explore mode with no context produces full exploration plan", () => {
    const ctx = baseContext({ phase: "explore", languages: [], userText: "Explore how the auth system works" });
    const gaps = analyzeGaps(ctx);
    const trigger = shouldTriggerSensemaking(gaps, makeDecision({ phase: "explore" }), 0);
    expect(trigger.trigger).toBe(true);

    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: trigger.reason, gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("<EXPLORATION_PLAN>");
    expect(block).toContain("Explore how the auth system works");
    expect(plan.forwardPath.length).toBeGreaterThan(0);
  });

  it("stalled verification with high-confidence recall still triggers on explore", () => {
    const ctx = baseContext({
      phase: "explore",
      languages: ["typescript"],
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.95, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
      verificationState: stalledVerifState(),
    });
    const gaps = analyzeGaps(ctx);
    const trigger = shouldTriggerSensemaking(gaps, makeDecision({ phase: "explore" }), 0);
    expect(trigger.trigger).toBe(true);
    expect(trigger.reason).toBe("explore_phase");
  });

  it("abstain path produces exploration plan that replaces generic framing", () => {
    const ctx = baseContext({
      languages: [],
      userText: "Implement the payment gateway",
    });
    const gaps = analyzeGaps(ctx);
    const trigger = shouldTriggerSensemaking(gaps, makeDecision({ decisionPath: "abstain" }), 0);
    expect(trigger.trigger).toBe(true);

    const plan = buildExplorationPlan(gaps, ctx);
    const result: SensemakingResult = { triggered: true, reason: trigger.reason, gaps, plan };
    const block = formatExplorationPlanBlock(result);

    expect(block).toContain("abstain_path");
    expect(block).toContain("Implement the payment gateway");
    expect(plan.preconditions.length).toBeGreaterThan(0);
  });

  it("all-known scenario does not trigger", () => {
    const ctx = baseContext({
      languages: ["typescript"],
      recallDecision: makeRecall({
        routing: "bypass",
        resolution: { confidence: 0.98, findings: [], resolvedCount: 1, totalFindings: 1 },
      }),
      verificationState: resolvedVerifState(),
      evidencePrefetched: true,
      evidenceConfidence: 0.95,
      evidenceAuthoritative: true,
    });
    const gaps = analyzeGaps(ctx);
    const trigger = shouldTriggerSensemaking(gaps, makeDecision(), 0);
    expect(trigger.trigger).toBe(false);
    expect(gaps.unknown.length).toBe(0);
    expect(gaps.knowBetter.length).toBe(0);
  });
});
