import { describe, expect, it } from "vitest";
import {
  buildContextMediationArtifacts,
  filterContextBlocksForMediation,
  verifyEvidenceBlockReferences,
} from "../src/memory/context-mediation.js";
import {
  applyArchitectureMediationMode,
  deriveModelExecutionPolicy,
  resolveModelArchitectureProfile,
} from "../src/providers/model-architecture-profile.js";

function hybridPolicy() {
  return applyArchitectureMediationMode(
    deriveModelExecutionPolicy(resolveModelArchitectureProfile({
      modelId: "mimo-v2.5-pro",
      declaredContextTokens: 1_000_000,
    })),
    "adaptive",
  );
}

describe("context mediation artifacts", () => {
  it("extracts pins, manifest entries, hygiene, and an active state header", () => {
    const artifacts = buildContextMediationArtifacts({
      messages: [
        { role: "system", content: "Security policy: never expose secrets." },
        { role: "user", content: "You must cite evidence block ctx-deadbeef00." },
        { role: "user", content: "File reference: src/app.ts" },
        { role: "tool", content: "pytest failed in tests/app.test.ts with AssertionError." },
      ],
      governanceBlocks: ["Task commitment: run npm test before final response."],
      policy: hybridPolicy(),
      projectRoot: "/repo",
      shellCwd: "/repo",
    });

    expect(artifacts.criticalFactPins.map((pin) => pin.source)).toEqual(expect.arrayContaining([
      "security_policy",
      "user_constraint",
      "file_reference",
      "tool_result",
      "task_commitment",
    ]));
    expect(artifacts.evidenceManifest.length).toBeGreaterThan(0);
    expect(artifacts.hygieneReport.criticalFactBlocks).toBeGreaterThan(0);
    expect(artifacts.activeStateHeader).toContain("<SYNESIS_ACTIVE_STATE");
    expect(artifacts.activeStateHeaderHash).toMatch(/^[a-f0-9]{16}$/);
    expect(artifacts.verificationWarnings).toContain("missing_evidence_block_id:ctx-deadbeef00");
  });

  it("filters duplicate and stale low-value blocks in safe/adaptive modes", () => {
    const policy = hybridPolicy();
    const result = filterContextBlocksForMediation([
      "Current fact: use src/app.ts",
      "Current fact: use src/app.ts",
      "stale obsolete placeholder note",
      "Critical security policy: never expose secrets",
    ], policy);

    expect(result.blocks).toEqual([
      "Current fact: use src/app.ts",
      "Critical security policy: never expose secrets",
    ]);
    expect(result.hygieneReport.duplicateBlocks).toBe(1);
    expect(result.hygieneReport.staleBlocks).toBe(1);
  });

  it("verifies hallucinated block IDs against a manifest", () => {
    expect(verifyEvidenceBlockReferences("Use ctx-1234567890", [])).toEqual([
      "missing_evidence_block_id:ctx-1234567890",
    ]);
  });
});
