import type {
  HarnessBehaviorSignal,
  HarnessTesterApiTraceSummary,
  HarnessTesterCommandResult,
  HarnessTesterResolvedTask,
  HarnessTesterWorkspaceSnapshot,
} from "./types.js";

export function classifyHarnessTesterRun(params: {
  task: HarnessTesterResolvedTask;
  setupResults: HarnessTesterCommandResult[];
  harnessResult: HarnessTesterCommandResult;
  validationResults: HarnessTesterCommandResult[];
  workspace: HarnessTesterWorkspaceSnapshot;
  apiTrace: HarnessTesterApiTraceSummary;
}): HarnessBehaviorSignal[] {
  const signals: HarnessBehaviorSignal[] = [];
  const transcript = [
    ...params.setupResults.map(commandText),
    commandText(params.harnessResult),
    ...params.validationResults.map(commandText),
  ].join("\n");

  addIf(signals, params.setupResults.some((result) => result.exitCode !== 0 || result.timedOut), {
    flag: "setup_failed",
    owner: "task_validation",
    severity: "error",
    detail: "At least one setup command failed or timed out.",
  });
  addIf(signals, params.harnessResult.timedOut, {
    flag: "timeout",
    owner: "model",
    severity: "error",
    detail: "Harness command timed out before producing a complete result.",
  });
  addIf(signals, params.harnessResult.exitCode !== 0 && !params.harnessResult.timedOut, {
    flag: "harness_noninteractive_failure",
    owner: "harness",
    severity: "error",
    detail: "Harness command exited non-zero in non-interactive execution.",
  });
  addIf(signals, params.validationResults.some((result) => result.exitCode !== 0 || result.timedOut), {
    flag: "validation_failed",
    owner: "task_validation",
    severity: "error",
    detail: "At least one deterministic validation command failed or timed out.",
  });
  addIf(signals, params.validationResults.length === 0 && /pass|success|complete|done/i.test(transcript), {
    flag: "empty_test_suite_treated_as_success",
    owner: "task_validation",
    severity: "warning",
    detail: "Run contains success language but no validation command evidence.",
  });
  addIf(signals, params.workspace.changedFiles.length === 0, {
    flag: "no_files_changed",
    owner: "model",
    severity: "error",
    detail: "No workspace files changed after the harness run.",
  });
  for (const expected of params.task.expected_changed ?? []) {
    addIf(signals, !matchesAnyChangedFile(params.workspace.changedFiles, expected), {
      flag: "expected_file_not_modified",
      owner: "task_validation",
      severity: "error",
      detail: `Expected changed file pattern was not modified: ${expected}`,
    });
  }
  for (const forbidden of params.task.forbidden_changed ?? []) {
    addIf(signals, matchesAnyChangedFile(params.workspace.changedFiles, forbidden), {
      flag: "forbidden_file_modified",
      owner: "task_validation",
      severity: "error",
      detail: `Forbidden changed file pattern was modified: ${forbidden}`,
    });
  }
  addIf(signals, params.workspace.diffSummary.filesChanged > 20, {
    flag: "large_unrelated_diff",
    owner: "model",
    severity: "warning",
    detail: `Diff touched ${params.workspace.diffSummary.filesChanged} files, which is unusually broad for a harness task.`,
  });
  addIf(signals, hasRepeatedFileReads(transcript), {
    flag: "repeated_file_reads",
    owner: "model",
    severity: "warning",
    detail: "Harness transcript suggests repeated reads of the same file or path.",
  });
  addIf(signals, hasRepeatedValidation(transcript) && params.workspace.changedFiles.length === 0, {
    flag: "repeated_validation_without_new_changes",
    owner: "model",
    severity: "warning",
    detail: "Validation commands repeated without evidence of new workspace changes.",
  });
  addIf(signals, /complete|fixed|passes|success/i.test(transcript) && params.validationResults.length === 0, {
    flag: "final_success_claim_without_validation",
    owner: "harness",
    severity: "warning",
    detail: "Harness claimed success without deterministic validation output.",
  });
  addIf(signals, /permission prompt|confirm|interactive|requires approval/i.test(transcript), {
    flag: "permission_prompt_blocked",
    owner: "harness",
    severity: "error",
    detail: "Harness output suggests an interactive permission prompt blocked progress.",
  });
  addIf(signals, /\/src\/test\/src\/test\/|path duplication|duplicate path|File not found: .*\/([^/\s]+\/){2,}.*\1/i.test(transcript), {
    flag: "cwd_path_confusion",
    owner: "model",
    severity: "error",
    detail: "Transcript suggests cwd/project-root path duplication or stale path reasoning.",
  });
  addIf(signals, /# Todos[\s\S]{0,1200}\[[x✓]\][\s\S]*# Todos[\s\S]{0,1200}\[ \]/i.test(transcript), {
    flag: "task_reset",
    owner: "model",
    severity: "warning",
    detail: "Todo/task state appears to reset after completed work.",
  });
  addIf(signals, /SchemaError|invalid arguments|Expected array|missing key/i.test(transcript) || params.apiTrace.schemaErrors > 0, {
    flag: "api_schema_error",
    owner: "upper_harness",
    severity: "error",
    detail: "Tool or API schema validation error detected.",
  });
  addIf(signals, /tool_call_parse|malformed tool|partial tool/i.test(transcript), {
    flag: "tool_call_parse_error",
    owner: "upper_harness",
    severity: "error",
    detail: "Tool call parsing issue detected.",
  });
  addIf(signals, /invalid_tool_result_shape|tool result shape/i.test(transcript), {
    flag: "invalid_tool_result_shape",
    owner: "upper_harness",
    severity: "error",
    detail: "Tool result shape was rejected or malformed.",
  });
  addIf(signals, !params.apiTrace.available, {
    flag: "trace_correlation_missing",
    owner: "upper_harness",
    severity: "warning",
    detail: params.apiTrace.error ?? "API trace correlation was unavailable.",
  });
  addAdaptationSignals(signals);
  return dedupeSignals(signals);
}

function commandText(result: HarnessTesterCommandResult): string {
  return [result.command, result.stdout, result.stderr].join("\n");
}

function addIf(signals: HarnessBehaviorSignal[], condition: boolean, signal: HarnessBehaviorSignal): void {
  if (condition) signals.push(signal);
}

function matchesAnyChangedFile(changedFiles: string[], pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`);
    return changedFiles.some((file) => regex.test(file));
  }
  return changedFiles.some((file) => file === pattern || file.startsWith(`${pattern}/`));
}

function hasRepeatedFileReads(transcript: string): boolean {
  const matches = transcript.match(/(?:Read|cat|sed -n|open)\s+([^\s\n]+)|→ Read ([^\s\n]+)/g) ?? [];
  return repeatedValue(matches.map((match) => match.replace(/^.*(?:Read|cat|sed -n|open)\s+/, "")));
}

function hasRepeatedValidation(transcript: string): boolean {
  const matches = transcript.match(/\b(?:pytest|npm test|npm run test|go test|cargo test|vitest|jest)\b[^\n]*/g) ?? [];
  return repeatedValue(matches.map((match) => match.trim()));
}

function repeatedValue(values: string[]): boolean {
  const counts = new Map<string, number>();
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    if (next >= 3) return true;
    counts.set(value, next);
  }
  return false;
}

function addAdaptationSignals(signals: HarnessBehaviorSignal[]): void {
  if (signals.some((signal) => signal.flag === "api_schema_error" || signal.flag === "tool_call_parse_error")) {
    signals.push({
      flag: "lora_candidate_tool_schema",
      owner: "model",
      severity: "info",
      detail: "Schema/tool failures may be useful examples for model adaptation or repair prompt tuning.",
    });
  }
  if (signals.some((signal) => signal.flag === "cwd_path_confusion" || signal.flag === "expected_file_not_modified")) {
    signals.push({
      flag: "lora_candidate_path_reasoning",
      owner: "model",
      severity: "info",
      detail: "Path/root confusion may be useful examples for model adaptation or work-packet policy tuning.",
    });
  }
  if (signals.some((signal) => signal.flag === "repeated_validation_without_new_changes" || signal.flag === "validation_failed")) {
    signals.push({
      flag: "lora_candidate_test_repair_loop",
      owner: "model",
      severity: "info",
      detail: "Validation repair loop behavior may be useful examples for model adaptation or harness policy tuning.",
    });
  }
}

function dedupeSignals(signals: HarnessBehaviorSignal[]): HarnessBehaviorSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.flag}:${signal.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
