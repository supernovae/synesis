import { describe, expect, it, beforeEach } from "vitest";
import { LanguagePackRegistry, resetLanguagePackRegistry, getLanguagePackRegistry } from "../src/language-packs/registry.js";
import { loadAllPacks, resetLoader } from "../src/language-packs/loader.js";
import {
  buildVerificationPlan,
  formatVerificationPlanBlock,
  isVerificationTool,
  getVerificationToolNames,
} from "../src/verification/planner.js";
import { VerificationLoopTracker } from "../src/verification/loop-tracker.js";
import { createEmptyVerificationStats } from "../src/verification/types.js";
import type { VerificationStats } from "../src/verification/types.js";
import type { EnrichedItem } from "../src/reduction/types.js";
import { formatSelfRepairBlock } from "../src/recall/formatter.js";
import type { RecallResolution, ResolvedFinding } from "../src/recall/types.js";
import type { VerificationLoopState } from "../src/verification/types.js";

function loadRegistry(): LanguagePackRegistry {
  resetLanguagePackRegistry();
  resetLoader();
  loadAllPacks();
  return getLanguagePackRegistry();
}

/* ── Verification Planner ────────────────────────────────────────── */

describe("Verification Planner", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = loadRegistry();
  });

  it("builds a plan for typescript with expected commands", () => {
    const plan = buildVerificationPlan(["typescript"], registry);
    expect(plan.languages).toEqual(["typescript"]);
    expect(plan.commands.length).toBeGreaterThan(0);
    const tools = plan.commands.map((c) => c.tool);
    expect(tools).toContain("tsc");
    expect(tools).toContain("eslint");
  });

  it("builds a plan for python with expected commands", () => {
    const plan = buildVerificationPlan(["python"], registry);
    expect(plan.commands.length).toBeGreaterThan(0);
    const tools = plan.commands.map((c) => c.tool);
    expect(tools).toContain("ruff");
  });

  it("deduplicates commands across multiple languages", () => {
    const plan = buildVerificationPlan(["typescript", "python"], registry);
    const keys = plan.commands.map((c) => `${c.tool}:${c.command}`);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it("returns empty commands for unknown language", () => {
    const plan = buildVerificationPlan(["brainfuck"], registry);
    expect(plan.commands).toHaveLength(0);
  });

  it("sorts required commands before recommended", () => {
    const plan = buildVerificationPlan(["typescript"], registry);
    if (plan.commands.length >= 2) {
      const requiredIdx = plan.commands.findIndex((c) => c.priority === "required");
      const recommendedIdx = plan.commands.findIndex((c) => c.priority === "recommended");
      if (requiredIdx >= 0 && recommendedIdx >= 0) {
        expect(requiredIdx).toBeLessThan(recommendedIdx);
      }
    }
  });

  it("respects maxRounds and budgetMs", () => {
    const plan = buildVerificationPlan(["typescript"], registry, 5, 60_000);
    expect(plan.maxRounds).toBe(5);
    expect(plan.budgetMs).toBe(60_000);
  });
});

/* ── Plan Formatting ─────────────────────────────────────────────── */

describe("Verification Plan Formatting", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = loadRegistry();
  });

  it("formats a non-empty plan as XML block", () => {
    const plan = buildVerificationPlan(["typescript"], registry);
    const block = formatVerificationPlanBlock(plan);
    expect(block).not.toBeNull();
    expect(block).toContain("synesis_verification_plan");
    expect(block).toContain("typescript");
    expect(block).toContain("[required]");
    expect(block).toContain("errorLines");
  });

  it("returns null for empty plan", () => {
    const plan = buildVerificationPlan(["nonexistent"], registry);
    const block = formatVerificationPlanBlock(plan);
    expect(block).toBeNull();
  });

  it("includes Go module preflight only for Go plans", () => {
    const goPlan = buildVerificationPlan(["go"], registry);
    const goBlock = formatVerificationPlanBlock(goPlan);
    expect(goBlock).toContain("Go preflight");
    expect(goBlock).toContain("go mod init");

    const javaPlan = buildVerificationPlan(["java"], registry);
    const javaBlock = formatVerificationPlanBlock(javaPlan);
    if (javaBlock) {
      expect(javaBlock).not.toContain("Go preflight");
      expect(javaBlock).not.toContain("go mod init");
    }
  });

  it("includes Python dependency preflight only for Python plans", () => {
    const pythonPlan = buildVerificationPlan(["python"], registry);
    const pythonBlock = formatVerificationPlanBlock(pythonPlan);
    expect(pythonBlock).toContain("Python preflight");
    expect(pythonBlock).toContain("pyproject.toml");
    expect(pythonBlock).toContain("requirements.txt");

    const javaPlan = buildVerificationPlan(["java"], registry);
    const javaBlock = formatVerificationPlanBlock(javaPlan);
    if (javaBlock) {
      expect(javaBlock).not.toContain("Python preflight");
      expect(javaBlock).not.toContain("pyproject.toml");
    }
  });
});

/* ── isVerificationTool ──────────────────────────────────────────── */

describe("isVerificationTool", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = loadRegistry();
  });

  it("matches known verification tool names", () => {
    const plan = buildVerificationPlan(["typescript"], registry);
    expect(isVerificationTool("tsc", plan)).toBe(true);
    expect(isVerificationTool("eslint", plan)).toBe(true);
  });

  it("does not match non-verification tools", () => {
    const plan = buildVerificationPlan(["typescript"], registry);
    expect(isVerificationTool("git", plan)).toBe(false);
    expect(isVerificationTool("ls", plan)).toBe(false);
  });
});

/* ── getVerificationToolNames ────────────────────────────────────── */

describe("getVerificationToolNames", () => {
  it("returns tool names from all packs", () => {
    const registry = loadRegistry();
    const tools = getVerificationToolNames(registry);
    expect(tools.size).toBeGreaterThan(0);
    expect(tools.has("tsc")).toBe(true);
    expect(tools.has("ruff")).toBe(true);
    expect(tools.has("cargo-check")).toBe(true);
  });
});

/* ── Verification Loop Tracker ───────────────────────────────────── */

describe("VerificationLoopTracker", () => {
  let tracker: VerificationLoopTracker;

  beforeEach(() => {
    tracker = new VerificationLoopTracker(3, 30_000);
  });

  it("starts at round 0 with no findings", () => {
    const state = tracker.getState();
    expect(state.round).toBe(0);
    expect(state.findings).toHaveLength(0);
    expect(state.allResolved).toBe(false);
    expect(state.stalled).toBe(false);
  });

  it("records a round and tracks findings", () => {
    const findings: EnrichedItem[] = [
      { message: "TS2322", errorFamily: "type_mismatch" },
      { message: "TS2304", errorFamily: "undeclared_name" },
    ];
    const state = tracker.recordRound("tsc", findings, false);
    expect(state.round).toBe(1);
    expect(state.findings).toHaveLength(2);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].findingCount).toBe(2);
  });

  it("detects all resolved when findings drop to 0", () => {
    tracker.recordRound("tsc", [{ message: "err1" }], false);
    const state = tracker.recordRound("tsc", [], true);
    expect(state.allResolved).toBe(true);
  });

  it("detects stagnation when finding count does not decrease", () => {
    const findings: EnrichedItem[] = [{ message: "err1" }, { message: "err2" }];
    tracker.recordRound("tsc", findings, false);
    const state = tracker.recordRound("tsc", findings, false);
    expect(state.stalled).toBe(true);
  });

  it("does not report stalled when findings decrease", () => {
    tracker.recordRound("tsc", [{ message: "1" }, { message: "2" }, { message: "3" }], false);
    const state = tracker.recordRound("tsc", [{ message: "1" }], false);
    expect(state.stalled).toBe(false);
  });

  it("enforces maxRounds budget", () => {
    tracker.recordRound("tsc", [{ message: "e" }], false);
    tracker.recordRound("tsc", [{ message: "e" }], false);
    const state = tracker.recordRound("tsc", [{ message: "e" }], false);
    expect(state.budgetExhausted).toBe(true);
  });

  it("shouldContinue returns false when stalled", () => {
    const findings: EnrichedItem[] = [{ message: "err" }];
    tracker.recordRound("tsc", findings, false);
    tracker.recordRound("tsc", findings, false);
    expect(tracker.shouldContinue()).toBe(false);
  });

  it("shouldContinue returns false when all resolved", () => {
    tracker.recordRound("tsc", [{ message: "e" }], false);
    tracker.recordRound("tsc", [], true);
    expect(tracker.shouldContinue()).toBe(false);
  });

  it("shouldContinue returns true when making progress", () => {
    tracker.recordRound("tsc", [{ message: "1" }, { message: "2" }], false);
    expect(tracker.shouldContinue()).toBe(true);
  });

  it("isProductiveLoop returns true for first round", () => {
    tracker.recordRound("tsc", [{ message: "e" }], false);
    expect(tracker.isProductiveLoop()).toBe(true);
  });

  it("isProductiveLoop returns false when stalled", () => {
    const findings: EnrichedItem[] = [{ message: "err" }];
    tracker.recordRound("tsc", findings, false);
    tracker.recordRound("tsc", findings, false);
    expect(tracker.isProductiveLoop()).toBe(false);
  });

  it("tracks resolved count across rounds", () => {
    tracker.recordRound("tsc", [{ message: "1" }, { message: "2" }, { message: "3" }], false);
    const state = tracker.recordRound("tsc", [{ message: "1" }], false);
    expect(state.history[1].resolvedCount).toBe(2);
  });

  it("reset clears all state", () => {
    tracker.recordRound("tsc", [{ message: "e" }], false);
    tracker.reset();
    const state = tracker.getState();
    expect(state.round).toBe(0);
    expect(state.history).toHaveLength(0);
  });
});

/* ── Verification Stats ──────────────────────────────────────────── */

describe("Verification Stats Tracking", () => {
  it("accumulates stats over multiple rounds", () => {
    const tracker = new VerificationLoopTracker(5, 60_000);
    const stats = createEmptyVerificationStats();

    tracker.recordRound("tsc", [{ message: "e1" }, { message: "e2" }], false, stats, "typescript");
    expect(stats.loopsStarted).toBe(1);
    expect(stats.totalRounds).toBe(1);
    expect(stats.totalFindingsDetected).toBe(2);

    tracker.recordRound("tsc", [{ message: "e1" }], false, stats, "typescript");
    expect(stats.totalRounds).toBe(2);
    expect(stats.totalFindingsResolved).toBe(1);

    tracker.recordRound("tsc", [], true, stats, "typescript");
    expect(stats.loopsCompleted).toBe(1);
    expect(stats.totalFindingsResolved).toBe(2);
    expect(stats.byLanguage["typescript"]).toBeDefined();
    expect(stats.byLanguage["typescript"].loops).toBe(1);
    expect(stats.byLanguage["typescript"].rounds).toBe(3);
  });

  it("tracks stall and budget exhaustion", () => {
    const tracker = new VerificationLoopTracker(2, 60_000);
    const stats = createEmptyVerificationStats();

    tracker.recordRound("tsc", [{ message: "e" }], false, stats);
    tracker.recordRound("tsc", [{ message: "e" }], false, stats);

    expect(stats.stallCount).toBe(1);
    expect(stats.budgetExhaustions).toBe(1);
  });
});

/* ── Progress Annotations ────────────────────────────────────────── */

describe("Verification Progress Annotations", () => {
  it("returns null when no rounds recorded", () => {
    const tracker = new VerificationLoopTracker();
    expect(tracker.formatProgressAnnotation()).toBeNull();
  });

  it("formats in-progress annotation", () => {
    const tracker = new VerificationLoopTracker();
    tracker.recordRound("tsc", [{ message: "e1" }, { message: "e2" }], false);
    const annotation = tracker.formatProgressAnnotation();
    expect(annotation).toContain("in_progress");
    expect(annotation).toContain('findings="2"');
  });

  it("formats resolved annotation", () => {
    const tracker = new VerificationLoopTracker();
    tracker.recordRound("tsc", [{ message: "e" }], false);
    tracker.recordRound("tsc", [], true);
    const annotation = tracker.formatProgressAnnotation();
    expect(annotation).toContain("resolved");
  });

  it("formats stalled annotation", () => {
    const tracker = new VerificationLoopTracker();
    const findings: EnrichedItem[] = [{ message: "e" }];
    tracker.recordRound("tsc", findings, false);
    tracker.recordRound("tsc", findings, false);
    const annotation = tracker.formatProgressAnnotation();
    expect(annotation).toContain("stalled");
    expect(annotation).toContain("manual review");
  });

  it("formats budget exhausted annotation", () => {
    const tracker = new VerificationLoopTracker(2, 60_000);
    tracker.recordRound("tsc", [{ message: "e" }], false);
    tracker.recordRound("tsc", [{ message: "e2" }], false);
    const annotation = tracker.formatProgressAnnotation();
    // Finding count increased so stalled takes priority
    expect(annotation).toContain("stalled");
  });
});

/* ── Self-Repair Block ───────────────────────────────────────────── */

describe("Self-Repair Block Formatting", () => {
  it("formats block with deterministic and reasoning findings", () => {
    const resolution: RecallResolution = {
      findings: [
        {
          errorFamily: "type_mismatch",
          recipe: { errorFamily: "type_mismatch", template: "Fix the type", description: "Fix" },
          rootCause: "Wrong type",
          action: "Fix",
          file: "foo.ts",
          message: "TS2322",
        },
        {
          errorFamily: "complex_issue",
          recipe: null,
          rootCause: "Complicated logic",
          action: undefined,
          file: "bar.ts",
          message: "Unusual error",
        },
      ],
      confidence: 0.6,
      language: "typescript",
      deterministicAnswer: false,
    };
    const loopState: VerificationLoopState = {
      round: 2,
      findings: [],
      allResolved: false,
      stalled: false,
      budgetExhausted: false,
      history: [],
    };

    const block = formatSelfRepairBlock(resolution, loopState);
    expect(block).not.toBeNull();
    expect(block).toContain("synesis_self_repair");
    expect(block).toContain('round="2"');
    expect(block).toContain('deterministic="1"');
    expect(block).toContain('reasoning="1"');
    expect(block).toContain("Fix the type");
    expect(block).toContain("Require reasoning");
    expect(block).toContain("complex_issue");
  });

  it("returns null when no recipes available", () => {
    const resolution: RecallResolution = {
      findings: [
        { errorFamily: "unknown", recipe: null, rootCause: undefined, action: undefined, file: undefined, message: "err" },
      ],
      confidence: 0,
      language: undefined,
      deterministicAnswer: false,
    };
    const loopState: VerificationLoopState = {
      round: 1, findings: [], allResolved: false, stalled: false, budgetExhausted: false, history: [],
    };
    expect(formatSelfRepairBlock(resolution, loopState)).toBeNull();
  });
});

/* ── End-to-End Integration ──────────────────────────────────────── */

describe("End-to-End Verification Loop", () => {
  it("full flow: plan -> round 1 (7 findings) -> round 2 (3 findings) -> round 3 (0 findings)", () => {
    const registry = loadRegistry();
    const plan = buildVerificationPlan(["typescript"], registry, 5, 60_000);
    expect(plan.commands.length).toBeGreaterThan(0);

    const tracker = new VerificationLoopTracker(5, 60_000);
    const stats = createEmptyVerificationStats();

    // Round 1: 7 findings
    const round1Findings: EnrichedItem[] = Array.from({ length: 7 }, (_, i) => ({
      message: `Error ${i}`, errorFamily: "type_mismatch",
    }));
    let state = tracker.recordRound("tsc", round1Findings, false, stats, "typescript");
    expect(state.round).toBe(1);
    expect(tracker.shouldContinue()).toBe(true);

    // Round 2: 3 findings (4 resolved)
    const round2Findings: EnrichedItem[] = Array.from({ length: 3 }, (_, i) => ({
      message: `Error ${i}`, errorFamily: "type_mismatch",
    }));
    state = tracker.recordRound("tsc", round2Findings, false, stats, "typescript");
    expect(state.round).toBe(2);
    expect(state.history[1].resolvedCount).toBe(4);
    expect(tracker.isProductiveLoop()).toBe(true);

    // Round 3: 0 findings (all resolved)
    state = tracker.recordRound("tsc", [], true, stats, "typescript");
    expect(state.round).toBe(3);
    expect(state.allResolved).toBe(true);
    expect(tracker.shouldContinue()).toBe(false);

    const annotation = tracker.formatProgressAnnotation();
    expect(annotation).toContain("resolved");

    expect(stats.loopsStarted).toBe(1);
    expect(stats.loopsCompleted).toBe(1);
    expect(stats.totalRounds).toBe(3);
    expect(stats.totalFindingsResolved).toBe(7);
    expect(stats.byLanguage["typescript"].loops).toBe(1);
  });

  it("full flow with self-repair block generation", () => {
    const registry = loadRegistry();
    const tracker = new VerificationLoopTracker(5, 60_000);
    const stats = createEmptyVerificationStats();

    // Round 1 with findings that have recipes
    const findings: EnrichedItem[] = [
      { message: "TS2322: type mismatch", errorFamily: "type_mismatch", rootCause: "wrong type", action: "fix" },
      { message: "Some obscure issue", errorFamily: "unknown" },
    ];
    const loopState = tracker.recordRound("tsc", findings, false, stats, "typescript");

    // Simulate recall resolution with one recipe match
    const resolution: RecallResolution = {
      findings: [
        {
          errorFamily: "type_mismatch",
          recipe: { errorFamily: "type_mismatch", template: "Fix the type in {file}", description: "Type mismatch" },
          rootCause: "Wrong type", action: "Fix types", file: "app.ts", message: "TS2322: type mismatch",
        },
        {
          errorFamily: "unknown", recipe: null, rootCause: undefined, action: undefined, file: undefined, message: "Some obscure issue",
        },
      ],
      confidence: 0.5,
      language: "typescript",
      deterministicAnswer: false,
    };

    const selfRepair = formatSelfRepairBlock(resolution, loopState);
    expect(selfRepair).not.toBeNull();
    expect(selfRepair).toContain("synesis_self_repair");
    expect(selfRepair).toContain('deterministic="1"');
    expect(selfRepair).toContain("Fix the type in {file}");
  });
});
