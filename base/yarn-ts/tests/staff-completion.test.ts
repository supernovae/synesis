import { describe, expect, it } from "vitest";
import {
  assessVerificationFromMessages,
  evaluateDeterministicPreFinalize,
} from "../src/verification/staff-completion.js";

describe("staff completion verification assessment", () => {
  it("detects blocking verification failures from tool outputs", () => {
    const assessment = assessVerificationFromMessages([
      {
        role: "tool",
        name: "run_lint",
        content: JSON.stringify({
          ok: false,
          preset: "python",
          summary: "failed exit=1 preset=python diagnostics=1",
          errorLines: ["app/main.py:12:5: F841 local variable 'x' is assigned to but never used"],
        }),
      },
    ]);
    expect(assessment.verificationSignals).toBe(1);
    expect(assessment.failingSignals).toBe(1);
    expect(assessment.hasBlockingFailures).toBe(true);
    expect(assessment.failures[0].category).toBe("format_or_lint");
  });

  it("does not block when verification signals are green", () => {
    const assessment = assessVerificationFromMessages([
      {
        role: "tool",
        name: "run_build",
        content: {
          ok: true,
          preset: "typescript_tsc",
          summary: "ok exit=0 preset=typescript_tsc",
          errorLines: [],
        },
      },
    ]);
    expect(assessment.verificationSignals).toBe(1);
    expect(assessment.failingSignals).toBe(0);
    expect(assessment.hasBlockingFailures).toBe(false);
  });
});

describe("deterministic pre-finalize critic", () => {
  it("blocks on remaining verification failures", () => {
    const out = evaluateDeterministicPreFinalize(
      {
        verificationSignals: 1,
        failingSignals: 1,
        hasBlockingFailures: true,
        failures: [
          {
            tool: "run_test",
            summary: "failed tests",
            category: "test",
            topErrorLines: ["tests/test_api.py:42: AssertionError"],
          },
        ],
      },
      ["apply_patch", "run_test"],
    );
    expect(out.blocked).toBe(true);
    expect(out.findings.join(" ")).toContain("Blocking verification failures remain");
    expect(out.suggestedNextActions.length).toBeGreaterThan(0);
  });

  it("blocks mutation-without-verification", () => {
    const out = evaluateDeterministicPreFinalize(
      {
        verificationSignals: 0,
        failingSignals: 0,
        hasBlockingFailures: false,
        failures: [],
      },
      ["apply_patch"],
    );
    expect(out.blocked).toBe(true);
    expect(out.findings.join(" ")).toContain("no verification evidence");
  });

  it("passes when no quality risk is detected", () => {
    const out = evaluateDeterministicPreFinalize(
      {
        verificationSignals: 2,
        failingSignals: 0,
        hasBlockingFailures: false,
        failures: [],
      },
      ["run_lint", "run_build"],
    );
    expect(out.blocked).toBe(false);
    expect(out.findings).toEqual([]);
  });
});
