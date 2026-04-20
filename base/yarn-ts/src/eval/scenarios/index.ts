/**
 * Scenario registry — all built-in eval scenarios accessible by
 * category or individual ID.
 */

import type { EvalScenario, EvalCategory } from "../types.js";
import { GOVERNOR_REGRESSION_SCENARIOS } from "./governor-regression.js";
import { E2E_BUILD_SCENARIOS } from "./e2e-builds.js";
import { GOLANG_WORKER_SCENARIOS } from "./golang-worker.js";
import { SWE_BENCH_SCENARIOS } from "./swe-bench-track.js";

export const ALL_SCENARIOS: EvalScenario[] = [
  ...GOVERNOR_REGRESSION_SCENARIOS,
  ...E2E_BUILD_SCENARIOS,
  ...GOLANG_WORKER_SCENARIOS,
  ...SWE_BENCH_SCENARIOS,
];

export function getScenariosByCategory(category: EvalCategory): EvalScenario[] {
  return ALL_SCENARIOS.filter(s => s.category === category);
}

export function getScenarioById(id: string): EvalScenario | undefined {
  return ALL_SCENARIOS.find(s => s.id === id);
}

export function listScenarios(): Array<{ id: string; name: string; category: EvalCategory; description: string }> {
  return ALL_SCENARIOS.map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
  }));
}

export { GOVERNOR_REGRESSION_SCENARIOS } from "./governor-regression.js";
export { E2E_BUILD_SCENARIOS } from "./e2e-builds.js";
export { GOLANG_WORKER_SCENARIOS } from "./golang-worker.js";
export { SWE_BENCH_SCENARIOS } from "./swe-bench-track.js";
