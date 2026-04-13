import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invokeGraph } from "../src/graph.js";
import { runCanonicalPipeline } from "../src/pipeline.js";
import type { GraphState } from "../src/state/types.js";

interface GoldenFixture {
  input: GraphState;
}

function loadFixture(name: string): GoldenFixture {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.resolve(currentDir, `fixtures/golden/${name}`);
  return JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenFixture;
}

function paritySnapshot(state: GraphState): Record<string, unknown> {
  return {
    next_node: state.next_node,
    plan_gate_passed: state.plan_gate_passed,
    critic_approved: state.critic_approved,
    need_more_evidence: state.need_more_evidence,
    clarification_question: state.clarification_question,
    clarification_options: state.clarification_options,
  };
}

describe("invokeGraph", () => {
  const parityFixtures = [
    "happy-path.json",
    "citation-gap.json",
    "critic-needs-evidence-loop.json",
  ];

  for (const fixtureName of parityFixtures) {
    it(`matches canonical pipeline for ${fixtureName}`, async () => {
      const fixture = loadFixture(fixtureName);
      const viaGraph = await invokeGraph(JSON.parse(JSON.stringify(fixture.input)));
      const viaPipeline = await runCanonicalPipeline(JSON.parse(JSON.stringify(fixture.input)));
      expect(paritySnapshot(viaGraph)).toEqual(paritySnapshot(viaPipeline));
      expect((viaGraph.generated_code ?? "").length).toBeGreaterThan(0);
      expect((viaPipeline.generated_code ?? "").length).toBeGreaterThan(0);
      expect((viaGraph.decision_ledger ?? []).length).toBeGreaterThan(0);
      expect((viaPipeline.decision_ledger ?? []).length).toBeGreaterThan(0);
    });
  }
});
