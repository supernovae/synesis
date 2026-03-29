import { describe, expect, it } from "vitest";
import { applyAdmissionPolicy } from "../src/validation/admission-policy.js";
import { ArtifactStore } from "../src/state/artifact-store.js";

describe("applyAdmissionPolicy", () => {
  it("keeps normalized summary when payload is below limits", () => {
    const store = new ArtifactStore();
    const envelope = {
      family: "generic" as const,
      outputFormat: "text" as const,
      findings: [{ family: "generic" as const, severity: "error" as const, message: "one" }],
      rawChars: 20,
      normalizedChars: 30,
      truncated: false,
      summary: "<VALIDATION_SUMMARY>1 issue</VALIDATION_SUMMARY>"
    };
    const res = applyAdmissionPolicy(envelope, "small output", { maxRawChars: 100, maxFindings: 10, includeRaw: false }, store);
    expect(res.usedArtifactHandle).toBe(false);
    expect(res.contentForModel).toContain("<VALIDATION_SUMMARY");
  });

  it("emits artifact handle when payload exceeds size limit", () => {
    const store = new ArtifactStore();
    const envelope = {
      family: "generic" as const,
      outputFormat: "text" as const,
      findings: [{ family: "generic" as const, severity: "error" as const, message: "one" }],
      rawChars: 5000,
      normalizedChars: 60,
      truncated: false,
      summary: "<VALIDATION_SUMMARY>1 issue</VALIDATION_SUMMARY>"
    };
    const raw = "x".repeat(5000);
    const res = applyAdmissionPolicy(envelope, raw, { maxRawChars: 1000, maxFindings: 10, includeRaw: false }, store);
    expect(res.usedArtifactHandle).toBe(true);
    expect(res.envelope.artifactHandle).toBeDefined();
    expect(res.contentForModel).toContain("artifact_handle=");
  });
});
