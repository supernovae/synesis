/**
 * SWE-bench-style scenarios focused on objective completion signals:
 * - concrete edit action
 * - verification evidence
 * - final completion response
 */

import type { EvalScenario } from "../types.js";

export const swebenchTypescriptPatch: EvalScenario = {
  id: "swebench-ts-version-constant",
  name: "SWE bench TS patch with verification",
  category: "swe_bench",
  description:
    "Model patches a TypeScript file, runs targeted tests, and reports completion with evidence.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Make one focused fix, verify it, then report completion succinctly.",
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Create src/version.ts exporting VERSION='1.2.3' and wire it into src/index.ts. " +
            "Run tests for the touched module only.",
        },
      ],
      simulatedToolResults: {
        Read: "src/index.ts currently logs an inline version string.",
        Write: "File written: src/version.ts",
        Edit: "Applied patch: src/index.ts imports VERSION from ./version",
        Bash: "PASS src/index.test.ts\n1 passed, 0 failed",
      },
      maxToolRounds: 4,
      assertions: [
        { type: "contains_edit" },
        { type: "no_repeated_tool" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 3,
    requiredOutcome: "completed",
    requireVerificationEvidence: true,
    requireSessionCompletionKpi: true,
    requiredToolActions: ["Write", "Bash"],
    requiredArtifactPaths: ["src/version.ts"],
    maxGovernorInterventions: 0,
  },
};

export const swebenchGoFix: EvalScenario = {
  id: "swebench-go-bundle-test-fix",
  name: "SWE bench Go fix with artifact + test",
  category: "swe_bench",
  description:
    "Model patches Go implementation and test, verifies with targeted command, and finalizes.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Apply minimal Go fixes and verify with narrow go test commands.",
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Fix failing bundle parser edge case in pkg/bundle/parser.go and add a regression test in pkg/bundle/parser_test.go.",
        },
      ],
      simulatedToolResults: {
        Read: "parser.go currently mishandles empty trailing separator values.",
        Edit: "Applied patch to pkg/bundle/parser.go",
        Write: "File written: pkg/bundle/parser_test.go",
        Bash: "ok  pkg/bundle 0.018s\nPASS\n0 failed",
      },
      maxToolRounds: 4,
      assertions: [
        { type: "contains_edit" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 3,
    requiredOutcome: "completed",
    requireVerificationEvidence: true,
    requireSessionCompletionKpi: true,
    requiredToolActions: ["Edit", "Bash"],
    requiredArtifactPaths: ["pkg/bundle/parser_test.go"],
    maxGovernorInterventions: 0,
  },
};

export const SWE_BENCH_SCENARIOS: EvalScenario[] = [
  swebenchTypescriptPatch,
  swebenchGoFix,
];
