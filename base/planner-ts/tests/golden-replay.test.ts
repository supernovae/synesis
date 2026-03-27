import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectOscillation } from "../src/nodes/oscillation-detector.js";
import {
  validateCitationPreservation,
  validateDecisionDrift,
  validateStyleCompliance
} from "../src/nodes/contract-validator.js";
import { runCanonicalPipeline } from "../src/pipeline.js";
import type { GraphState } from "../src/state/types.js";
import {
  evaluateWithPythonBaseline,
  isPythonBaselineCompareEnabled
} from "./python-baseline-adapter.js";

interface GoldenFixture {
  name: string;
  input: GraphState;
  expect: {
    next_node?: string;
    critic_approved?: boolean;
    need_more_evidence?: boolean;
    plan_gate_passed?: boolean;
    critique_register_min_items?: number;
    validation_warnings_min_items?: number;
    decision_ledger_min_items?: number;
    node_traces_min_items?: number; // legacy alias — maps to spans
    spans_min_items?: number;
    generated_contains_all?: string[];
    authz_trace_all_nodes?: boolean;
  };
}

function loadFixtures(): GoldenFixture[] {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturesDir = path.resolve(currentDir, "fixtures/golden");
  return readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8")) as GoldenFixture);
}

describe("golden replay", () => {
  const fixtures = loadFixtures();
  for (const fixture of fixtures) {
    it(`replays ${fixture.name}`, async () => {
      const out = await runCanonicalPipeline(fixture.input);
      if (fixture.expect.next_node !== undefined) {
        expect(out.next_node).toBe(fixture.expect.next_node);
      }
      if (fixture.expect.critic_approved !== undefined) {
        expect(out.critic_approved).toBe(fixture.expect.critic_approved);
      }
      if (fixture.expect.need_more_evidence !== undefined) {
        expect(out.need_more_evidence).toBe(fixture.expect.need_more_evidence);
      }
      if (fixture.expect.plan_gate_passed !== undefined) {
        expect(out.plan_gate_passed).toBe(fixture.expect.plan_gate_passed);
      }
      if (fixture.expect.critique_register_min_items !== undefined) {
        expect(Object.keys(out.critique_register ?? {}).length).toBeGreaterThanOrEqual(
          fixture.expect.critique_register_min_items
        );
      }
      if (fixture.expect.validation_warnings_min_items !== undefined) {
        expect((out._validation_warnings ?? []).length).toBeGreaterThanOrEqual(
          fixture.expect.validation_warnings_min_items
        );
      }
      if (fixture.expect.decision_ledger_min_items !== undefined) {
        expect((out.decision_ledger ?? []).length).toBeGreaterThanOrEqual(
          fixture.expect.decision_ledger_min_items
        );
      }
      const minSpans = fixture.expect.spans_min_items ?? fixture.expect.node_traces_min_items;
      if (minSpans !== undefined) {
        const spans = out._span_collector?.getSpans() ?? [];
        expect(spans.length).toBeGreaterThanOrEqual(minSpans);
      }
      if (fixture.expect.generated_contains_all !== undefined) {
        const draft = out.generated_code ?? "";
        for (const marker of fixture.expect.generated_contains_all) {
          expect(draft).toContain(marker);
        }
      }
      if (fixture.expect.authz_trace_all_nodes === true) {
        const expectedTrace = fixture.input.authz_trace_id ?? "";
        expect(expectedTrace.length).toBeGreaterThan(0);
        const spans = out._span_collector?.getSpans() ?? [];
        expect(spans.length).toBeGreaterThan(0);
      }

      if (isPythonBaselineCompareEnabled()) {
        const py = evaluateWithPythonBaseline(out);
        const tsStyle = validateStyleCompliance(out);
        const tsDecision = validateDecisionDrift(out);
        const tsCitation = validateCitationPreservation(out);
        const tsOsc = detectOscillation(out);

        expect(py.style_passed).toBe(tsStyle.passed);
        expect(py.decision_passed).toBe(tsDecision.passed);
        expect(py.citation_passed).toBe(tsCitation.passed);
        expect(py.style_violations_count).toBe(tsStyle.violations.length);
        expect(py.decision_violations_count).toBe(tsDecision.violations.length);
        expect(py.citation_violations_count).toBe(tsCitation.violations.length);
        expect(Math.abs(py.oscillation_total_score - tsOsc.total_score)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(py.oscillation_decision_score - tsOsc.decision_score)).toBeLessThanOrEqual(0.05);
      }
    });
  }
});
