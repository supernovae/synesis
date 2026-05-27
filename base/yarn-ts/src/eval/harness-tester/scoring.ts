import type { HarnessBehaviorSignal, HarnessTesterCommandResult, HarnessTesterReport } from "./types.js";

export function buildHarnessTesterScores(params: {
  setupResults: HarnessTesterCommandResult[];
  harnessResult: HarnessTesterCommandResult;
  validationResults: HarnessTesterCommandResult[];
  behavioralFlags: HarnessBehaviorSignal[];
  durationSeconds: number;
  timeoutSeconds?: number;
}): Pick<HarnessTesterReport, "native_scores" | "normalized_scores"> {
  const setupPassed = params.setupResults.every((result) => result.exitCode === 0 && !result.timedOut);
  const harnessPassed = params.harnessResult.exitCode === 0 && !params.harnessResult.timedOut;
  const validationPassed = params.validationResults.length > 0
    && params.validationResults.every((result) => result.exitCode === 0 && !result.timedOut);
  const errorFlags = params.behavioralFlags.filter((signal) => signal.severity === "error");
  const warningFlags = params.behavioralFlags.filter((signal) => signal.severity === "warning");
  const toolErrorFlags = params.behavioralFlags.filter((signal) =>
    signal.flag === "api_schema_error"
    || signal.flag === "tool_call_parse_error"
    || signal.flag === "invalid_tool_result_shape");
  const timeout = params.timeoutSeconds ?? 300;
  const efficiency = clamp01(1 - (params.durationSeconds / timeout));
  return {
    native_scores: {
      setup_passed: setupPassed,
      harness_exit_code: params.harnessResult.exitCode ?? "null",
      validation_passed: validationPassed,
      validation_command_count: params.validationResults.length,
      behavioral_error_count: errorFlags.length,
      behavioral_warning_count: warningFlags.length,
      duration_seconds: params.durationSeconds,
    },
    normalized_scores: {
      task_success: setupPassed && harnessPassed && validationPassed && errorFlags.length === 0 ? 1 : 0,
      tool_call_reliability: toolErrorFlags.length === 0 ? 1 : 0,
      patch_correctness: validationPassed && !errorFlags.some((signal) => signal.owner === "task_validation") ? 1 : 0,
      instruction_following: errorFlags.some((signal) => signal.flag === "forbidden_file_modified" || signal.flag === "expected_file_not_modified") ? 0 : 1,
      efficiency_score: Number(efficiency.toFixed(3)),
    },
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
