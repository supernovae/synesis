/**
 * Eval Gym — public API surface.
 */

export type {
  EvalScenario,
  EvalTurn,
  TurnAssertion,
  ScoringCriteria,
  EvalRunnerConfig,
  ScenarioResult,
  TurnResult,
  Anomaly,
  ObserverConfig,
  ObservedTurn,
  TrainingFormat,
  SftExample,
  DpoExample,
  RlaifExample,
  EvalCategory,
} from "./types.js";

export { EVAL_EVENT_KINDS } from "./types.js";
export { runScenario, runScenarios } from "./scenario-runner.js";
export { detectAnomalies, scoreTurn, scoreScenario } from "./turn-scorer.js";
export {
  isObserverEnabled,
  enableObserver,
  disableObserver,
  shouldObserveSession,
  buildObservedTurn,
  buildTranscriptEvent,
  buildLiveEvalEvent,
} from "./session-observer.js";
export { materialize, materializeSft, materializeDpo, materializeRlaif, toJsonl, scenarioResultToTrajectoryRow } from "./training-materializer.js";
export { ALL_SCENARIOS, getScenariosByCategory, getScenarioById, listScenarios } from "./scenarios/index.js";
export { registerEvalRoutes } from "./routes.js";
