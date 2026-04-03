import { describe, expect, it } from "vitest";
import {
  annotateViolations,
  fingerprintDraft,
  validateMermaidSyntax,
  validateCitationPreservation,
  validateDecisionDrift,
  validateStyleCompliance
} from "../src/nodes/contract-validator.js";

describe("contract validators", () => {
  it("flags style preamble when direct_answer_first is required", () => {
    const result = validateStyleCompliance({
      style_contract_locked: { direct_answer_first: true },
      generated_code: "Before we begin, this is context.\n\nAnswer."
    });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("direct_answer_first"))).toBe(true);
  });

  it("flags decision drift on rejected alternative", () => {
    const result = validateDecisionDrift({
      decision_ledger: [
        {
          decision_id: "db_choice",
          category: "architecture",
          chosen: "PostgreSQL",
          rejected_alternatives: ["MongoDB"],
          rationale: "",
          decided_by: "planner",
          frozen: true
        }
      ],
      override_log: [],
      generated_code: "We recommend using MongoDB for this project."
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain("decision_drift");
  });

  it("allows approved decision override", () => {
    const result = validateDecisionDrift({
      decision_ledger: [
        {
          decision_id: "db_choice",
          category: "architecture",
          chosen: "PostgreSQL",
          rejected_alternatives: ["MongoDB"],
          rationale: "",
          decided_by: "planner",
          frozen: true
        }
      ],
      override_log: [{ target_decision_id: "db_choice", approved: true, override_reason: "client requirement" }],
      generated_code: "We recommend using MongoDB for this project."
    });
    expect(result.passed).toBe(true);
  });

  it("flags dropped citations on revision", () => {
    const result = validateCitationPreservation({
      draft_fingerprints: ["a", "b"],
      evidence_packets: [
        {
          query: "guide",
          summary: "",
          confidence: 0.8,
          retrieval_notes: "",
          sources: [{ uri: "https://docs.example.com/guide", type: "doc", metadata: {} }],
          snippets: []
        }
      ],
      generated_code: "Recommendation without citation."
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain("citation_dropped");
  });

  it("annotates violations into critique register", () => {
    const annotated = annotateViolations({ critique_register: {} }, ["style: violation"]);
    const values = Object.values(annotated.critique_register);
    expect(values).toHaveLength(1);
    expect(values[0]?.status).toBe("open");
  });

  it("fingerprints deterministically", () => {
    expect(fingerprintDraft("abc")).toBe(fingerprintDraft("abc"));
    expect(fingerprintDraft("abc")).not.toBe(fingerprintDraft("abcd"));
  });

  it("flags forbidden Mermaid directives when strict guard is enabled", () => {
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED = "true";
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_STRICT = "true";
    const result = validateMermaidSyntax({
      generated_code: [
        "```mermaid",
        "graph TD",
        "A[Start] --> B[End]",
        "style A fill:#fff",
        "```",
      ].join("\n"),
    });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("mermaid_forbidden_directive"))).toBe(true);
  });
});
