import { describe, it, expect } from "vitest";
import {
  classifyIntentScope,
  getScopeThresholds,
} from "../src/governance/intent-scope-classifier.js";
import {
  createDiffStats,
  recordEditOperation,
  recordFileCreated,
  recordFileDeletion,
  parseEditMetrics,
  isFileDeletion,
  assessProportionality,
  proportionalityToSignal,
} from "../src/governance/diff-accumulator.js";
import {
  evaluateSensemakingGovernor,
} from "../src/governance/sensemaking-governor.js";
import type { ExecutionGovernorDecision, SessionPhase } from "../src/governance/execution-governor.js";

// ─── Intent Scope Classifier ──────────────────────────────────────────────────

describe("classifyIntentScope", () => {
  it("classifies security fix prompts as narrow_fix", () => {
    const result = classifyIntentScope("fix the security vulnerabilities in the REPL");
    expect(result.envelope).toBe("narrow_fix");
    expect(result.riskModifier).toBeGreaterThan(0.5);
  });

  it("classifies bug fix prompts as narrow_fix", () => {
    const result = classifyIntentScope("resolve the bug with authentication errors");
    expect(result.envelope).toBe("narrow_fix");
  });

  it("classifies refactor prompts as targeted_refactor", () => {
    const result = classifyIntentScope("refactor the database access layer");
    expect(result.envelope).toBe("targeted_refactor");
    expect(result.riskModifier).toBe(0.4);
  });

  it("classifies cleanup prompts as targeted_refactor", () => {
    const result = classifyIntentScope("clean up the authentication module");
    expect(result.envelope).toBe("targeted_refactor");
  });

  it("classifies rewrite prompts as broad_refactor", () => {
    const result = classifyIntentScope("rewrite the entire caching layer from scratch");
    expect(result.envelope).toBe("broad_refactor");
  });

  it("classifies explicit removal as removal_ok", () => {
    const result = classifyIntentScope("remove the legacy authentication module entirely");
    expect(result.envelope).toBe("removal_ok");
    expect(result.riskModifier).toBe(0);
  });

  it("returns unconstrained for generic prompts", () => {
    const result = classifyIntentScope("implement user profile page");
    expect(result.envelope).toBe("unconstrained");
  });

  it("returns unconstrained for empty input", () => {
    expect(classifyIntentScope("").envelope).toBe("unconstrained");
    expect(classifyIntentScope("   ").envelope).toBe("unconstrained");
  });

  it("removal takes precedence over narrow fix", () => {
    const result = classifyIntentScope("remove the feature that has security issues");
    expect(result.envelope).toBe("removal_ok");
  });

  it("classifies CVE fix as narrow_fix", () => {
    const result = classifyIntentScope("patch CVE-2024-12345 in the API handler");
    expect(result.envelope).toBe("narrow_fix");
  });
});

describe("getScopeThresholds", () => {
  it("returns thresholds for narrow_fix", () => {
    const t = getScopeThresholds("narrow_fix");
    expect(t).toBeTruthy();
    expect(t!.maxFilesModified).toBe(3);
    expect(t!.maxFilesDeleted).toBe(0);
    expect(t!.maxNetLinesRemoved).toBe(50);
  });

  it("returns wider thresholds for targeted_refactor", () => {
    const t = getScopeThresholds("targeted_refactor");
    expect(t).toBeTruthy();
    expect(t!.maxFilesModified).toBe(10);
    expect(t!.maxFilesDeleted).toBe(2);
  });

  it("returns null for unconstrained", () => {
    expect(getScopeThresholds("unconstrained")).toBeNull();
  });

  it("returns null for removal_ok", () => {
    expect(getScopeThresholds("removal_ok")).toBeNull();
  });

  it("accepts overrides", () => {
    const t = getScopeThresholds("narrow_fix", {
      narrow_fix: { maxFilesModified: 5 },
    });
    expect(t!.maxFilesModified).toBe(5);
    expect(t!.maxNetLinesRemoved).toBe(50); // default preserved
  });
});

// ─── Diff Accumulator ─────────────────────────────────────────────────────────

describe("DiffAccumulator", () => {
  it("tracks file edits", () => {
    const stats = createDiffStats();
    recordEditOperation(stats, "src/a.ts", 10, 5);
    recordEditOperation(stats, "src/b.ts", 3, 0);

    expect(stats.filesModified).toBe(2);
    expect(stats.linesAdded).toBe(13);
    expect(stats.linesRemoved).toBe(5);
    expect(stats.netLinesRemoved).toBe(-8); // net addition
    expect(stats.touchedPaths.size).toBe(2);
  });

  it("tracks largest single deletion", () => {
    const stats = createDiffStats();
    recordEditOperation(stats, "src/a.ts", 0, 30);
    recordEditOperation(stats, "src/b.ts", 0, 100);
    recordEditOperation(stats, "src/c.ts", 0, 10);

    expect(stats.largestSingleDeletion?.path).toBe("src/b.ts");
    expect(stats.largestSingleDeletion?.linesRemoved).toBe(100);
  });

  it("does not double-count same file", () => {
    const stats = createDiffStats();
    recordEditOperation(stats, "src/a.ts", 5, 5);
    recordEditOperation(stats, "src/a.ts", 3, 2);

    expect(stats.filesModified).toBe(1);
    expect(stats.linesAdded).toBe(8);
    expect(stats.linesRemoved).toBe(7);
  });

  it("tracks file creation", () => {
    const stats = createDiffStats();
    recordFileCreated(stats, "src/new.ts");
    expect(stats.filesCreated).toBe(1);
    expect(stats.touchedPaths.has("src/new.ts")).toBe(true);
  });

  it("tracks file deletion", () => {
    const stats = createDiffStats();
    recordFileDeletion(stats, "src/old.ts", 150);
    expect(stats.filesDeleted).toBe(1);
    expect(stats.linesRemoved).toBe(150);
    expect(stats.netLinesRemoved).toBe(150);
  });
});

describe("parseEditMetrics", () => {
  it("parses 'added N line(s)' format", () => {
    const m = parseEditMetrics("added 5 lines, removed 3 lines");
    expect(m.added).toBe(5);
    expect(m.removed).toBe(3);
  });

  it("parses git diff --stat format", () => {
    const m = parseEditMetrics("2 files changed, 15 insertions(+), 8 deletions(-)");
    expect(m.added).toBe(15);
    expect(m.removed).toBe(8);
  });

  it("parses compact +N -M format", () => {
    const m = parseEditMetrics("+20 -5");
    expect(m.added).toBe(20);
    expect(m.removed).toBe(5);
  });

  it("returns zeros for no matches", () => {
    const m = parseEditMetrics("All tests passed");
    expect(m.added).toBe(0);
    expect(m.removed).toBe(0);
  });
});

describe("isFileDeletion", () => {
  it("detects null/undefined as deletion", () => {
    expect(isFileDeletion(null)).toBe(true);
    expect(isFileDeletion(undefined)).toBe(true);
  });

  it("detects empty content as deletion", () => {
    expect(isFileDeletion("")).toBe(true);
    expect(isFileDeletion("   ")).toBe(true);
  });

  it("non-empty content is not a deletion", () => {
    expect(isFileDeletion("const x = 1;")).toBe(false);
  });
});

// ─── Proportionality Assessment ───────────────────────────────────────────────

describe("assessProportionality", () => {
  it("returns proportional when within thresholds", () => {
    const stats = createDiffStats();
    recordEditOperation(stats, "src/a.ts", 10, 5);
    const result = assessProportionality(stats, "narrow_fix");
    expect(result.level).toBe("proportional");
    expect(result.breaches).toHaveLength(0);
  });

  it("detects elevated when single threshold breached", () => {
    const stats = createDiffStats();
    recordEditOperation(stats, "src/a.ts", 5, 3);
    recordEditOperation(stats, "src/b.ts", 5, 3);
    recordEditOperation(stats, "src/c.ts", 5, 3);
    recordEditOperation(stats, "src/d.ts", 5, 3); // 4 files > maxFilesModified(3), but net removal is small
    const result = assessProportionality(stats, "narrow_fix");
    expect(result.level).toBe("elevated");
    expect(result.breaches.length).toBe(1);
    expect(result.breaches[0]).toContain("files_modified");
  });

  it("detects dangerous when file deleted in narrow_fix scope", () => {
    const stats = createDiffStats();
    recordFileDeletion(stats, "src/repl.ts", 200);
    const result = assessProportionality(stats, "narrow_fix");
    expect(result.level).toBe("dangerous");
  });

  it("detects dangerous when multiple severe breaches", () => {
    const stats = createDiffStats();
    for (let i = 0; i < 12; i++) {
      recordEditOperation(stats, `src/file${i}.ts`, 0, 30);
    }
    const result = assessProportionality(stats, "narrow_fix");
    expect(result.level).toBe("dangerous");
  });

  it("returns proportional for unconstrained scope", () => {
    const stats = createDiffStats();
    for (let i = 0; i < 50; i++) {
      recordFileDeletion(stats, `src/file${i}.ts`, 100);
    }
    const result = assessProportionality(stats, "unconstrained");
    expect(result.level).toBe("proportional");
  });

  it("returns proportional for removal_ok scope", () => {
    const stats = createDiffStats();
    recordFileDeletion(stats, "src/old.ts", 500);
    const result = assessProportionality(stats, "removal_ok");
    expect(result.level).toBe("proportional");
  });

  it("wide thresholds for broad_refactor", () => {
    const stats = createDiffStats();
    for (let i = 0; i < 20; i++) {
      recordEditOperation(stats, `src/file${i}.ts`, 5, 10);
    }
    const result = assessProportionality(stats, "broad_refactor");
    expect(result.level).toBe("proportional");
  });
});

describe("proportionalityToSignal", () => {
  it("maps elevated to scope_exceeded_narrow", () => {
    expect(proportionalityToSignal("elevated")).toBe("scope_exceeded_narrow");
  });

  it("maps disproportionate to scope_exceeded_moderate", () => {
    expect(proportionalityToSignal("disproportionate")).toBe("scope_exceeded_moderate");
  });

  it("maps dangerous to scope_exceeded_dangerous", () => {
    expect(proportionalityToSignal("dangerous")).toBe("scope_exceeded_dangerous");
  });

  it("returns null for proportional", () => {
    expect(proportionalityToSignal("proportional")).toBeNull();
  });
});

// ─── Sensemaking Integration ──────────────────────────────────────────────────

function makeLegacy(overrides: Partial<ExecutionGovernorDecision> = {}): ExecutionGovernorDecision {
  return {
    pause: false,
    reason: "ok",
    matchedRules: ["allow"],
    telemetry: {
      phase: "edit" as SessionPhase,
      repeatedTestCommands: 0,
      repeatedReadSearchCalls: 0,
      repeatedBroadDiscoveryCalls: 0,
      totalBroadDiscoveryCalls: 0,
      broadTestRepeat: false,
      noEditEvidence: false,
      trailingVerificationRunLength: 0,
    },
    ...overrides,
  };
}

describe("sensemaking governor proportionality signal integration", () => {
  it("scope_exceeded_narrow contributes advisory friction", () => {
    const decision = evaluateSensemakingGovernor(
      makeLegacy(),
      [],
      1,
      2,
      false,
      null,
      "scope_exceeded_narrow",
    );
    expect(decision.frictionScore).toBeGreaterThan(0);
    expect(decision.firedSignals.some((s) => s.name === "scope_exceeded_narrow")).toBe(true);
    // Single advisory signal alone may be allow or nudge depending on threshold
    expect(["allow", "nudge"]).toContain(decision.responseLevel);
  });

  it("scope_exceeded_moderate contributes complicated friction", () => {
    const decision = evaluateSensemakingGovernor(
      makeLegacy(),
      [],
      1,
      5,
      false,
      null,
      "scope_exceeded_moderate",
    );
    expect(decision.frictionScore).toBeGreaterThan(0.1);
    expect(decision.firedSignals.some((s) => s.name === "scope_exceeded_moderate")).toBe(true);
  });

  it("scope_exceeded_dangerous alone pushes toward guide/intervene", () => {
    const decision = evaluateSensemakingGovernor(
      makeLegacy(),
      [],
      1,
      0,
      false,
      null,
      "scope_exceeded_dangerous",
    );
    expect(decision.frictionScore).toBeGreaterThan(0.2);
    expect(decision.firedSignals.some((s) => s.name === "scope_exceeded_dangerous")).toBe(true);
  });

  it("proportionality signal combined with other friction amplifies response", () => {
    const decision = evaluateSensemakingGovernor(
      makeLegacy({ matchedRules: ["allow", "verification_churn_no_edit", "no_progress_loop"] }),
      [],
      3,
      0,
      false,
      null,
      "scope_exceeded_moderate",
    );
    expect(decision.frictionScore).toBeGreaterThan(0.3);
    expect(decision.responseLevel).not.toBe("allow");
  });

  it("null proportionality signal has no effect", () => {
    const withNull = evaluateSensemakingGovernor(makeLegacy(), [], 1, 0, false, null, null);
    const withUndefined = evaluateSensemakingGovernor(makeLegacy(), [], 1, 0, false, null, undefined);
    expect(withNull.frictionScore).toBe(withUndefined.frictionScore);
  });
});
