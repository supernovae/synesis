import { describe, it, expect } from "vitest";
import { compareTrials, type Trial } from "../src/compare.js";
function rows(): Trial[] {
  const output: Trial[] = [];
  for (const [category, count] of Object.entries({ public: 20, private: 20, coding: 10, research: 10 })) {
    for (let index=0; index<count; index++) for (const model of ["qwen", "deepseek"]) for (const harness of category === "coding" ? ["client-a", "client-b"] : ["chat"]) for (const candidate of ["knowledge-first", "front-door"] as const) {
      output.push({ candidate, category: category as Trial['category'], task: `${category}-${index}`, model, modelFamily: model, suiteRole: "heldout",
        modelRevision: "pinned", harness, harnessRevision: "pinned",
        corpusSha256: "a".repeat(64), suiteSha256: "b".repeat(64), knowledge: "source", repeat: 0,
        passed: true, outcomeSource: "deterministic", elapsedMs: 20, costUsd: 1, costComplete: true,
        tokens: 50, falseInterventions: 0, protocolPassed: true, securityPassed: true, live: true });
    }
  }
  return output;
}
describe("evidence for additional complexity", () => {
  it("reports missing quality evidence without blocking architecture decisions", () => {
    expect(compareTrials([]).decision).toBe("insufficient_evidence");
    expect(compareTrials([]).scope).toBe("incremental-complexity-evidence");
    expect(compareTrials(rows().map(r => ({...r,live:false}))).decision).toBe("insufficient_evidence");
    expect(compareTrials(rows().slice(2)).decision).toBe("insufficient_evidence");
  });
  it("defaults to the simpler candidate on equal outcomes", () => {
    expect(compareTrials(rows()).decision).toBe("knowledge-first");
  });
  it("requires actual known costs for a cost claim", () => {
    expect(compareTrials(rows().map(r => ({...r,costUsd:null}))).costReduction).toBeNull();
    expect(compareTrials(rows().map(r => ({...r,costComplete:false}))).decision).toBe("knowledge-first");
  });
  it("retains measured cost benefits only with fidelity and no extra interventions", () => {
    const improved=rows().map(r => ({...r,costUsd:r.candidate==='front-door'?0.6:1}));
    expect(compareTrials(improved).decision).toBe("front-door");
    improved[1].protocolPassed=false;
    expect(compareTrials(improved).decision).toBe("knowledge-first");
  });
  it("rejects duplicate trials and mismatched revisions", () => {
    expect(()=>compareTrials([...rows(),rows()[0]])).toThrow('Duplicate');
    expect(compareTrials(rows().map(r => r.candidate==='front-door'?{...r,modelRevision:'other'}:r)).decision).toBe('insufficient_evidence');
  });
  it("does not recommend a baseline that fails conformance", () => {
    const failed = rows();
    failed[0].securityPassed = false;
    expect(compareTrials(failed).decision).toBe("insufficient_evidence");
    expect(compareTrials(failed).reasons.join(" ")).toContain("Baseline fails");
  });
});
