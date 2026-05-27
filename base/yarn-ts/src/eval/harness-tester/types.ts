export type HarnessTesterStatus = "pass" | "fail" | "error" | "timeout";

export type HarnessFailureOwner = "harness" | "upper_harness" | "model" | "task_validation";

export type HarnessBenchmarkKind =
  | "harness-task"
  | "swe-bench"
  | "xlam"
  | "humaneval"
  | "mt-bench"
  | "alpacaeval"
  | "toxigen";

export type HarnessBehaviorFlag =
  | "repeated_file_reads"
  | "repeated_validation_without_new_changes"
  | "final_success_claim_without_validation"
  | "api_schema_error"
  | "tool_call_parse_error"
  | "invalid_tool_result_shape"
  | "empty_test_suite_treated_as_success"
  | "excessive_context_growth"
  | "timeout"
  | "no_files_changed"
  | "forbidden_file_modified"
  | "expected_file_not_modified"
  | "large_unrelated_diff"
  | "harness_noninteractive_failure"
  | "permission_prompt_blocked"
  | "command_failed"
  | "validation_failed"
  | "setup_failed"
  | "trace_correlation_missing"
  | "governor_false_positive"
  | "path_context_misleading"
  | "work_packet_stale"
  | "cwd_path_confusion"
  | "task_reset"
  | "lora_candidate_tool_schema"
  | "lora_candidate_path_reasoning"
  | "lora_candidate_test_repair_loop"
  | "prompt_policy_candidate"
  | "harness_policy_candidate";

export interface HarnessTesterTaskSpec {
  id: string;
  name: string;
  prompt: string;
  fixture: string;
  benchmark?: HarnessBenchmarkKind;
  benchmark_metadata?: Record<string, unknown>;
  setup?: string[];
  validate?: string[];
  expected_changed?: string[];
  forbidden_changed?: string[];
  timeout_seconds?: number;
  max_turns?: number;
  max_tool_calls?: number;
  env?: Record<string, string>;
  tags?: string[];
}

export interface HarnessTesterSuiteSpec {
  id: string;
  name: string;
  tasks: string[];
  defaults?: {
    timeout_seconds?: number;
    tags?: string[];
  };
}

export interface HarnessTesterResolvedTask extends HarnessTesterTaskSpec {
  taskPath: string;
  fixturePath: string;
}

export interface HarnessTesterCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HarnessTesterCommandSpec {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface HarnessTesterAdapterInput {
  task: HarnessTesterResolvedTask;
  runId: string;
  sessionKey: string;
  workspacePath: string;
  promptFilePath: string;
  model: string;
  apiBaseUrl: string;
  apiKey?: string;
  env?: Record<string, string>;
}

export interface HarnessTesterAdapter {
  name: string;
  buildCommand(input: HarnessTesterAdapterInput): HarnessTesterCommandSpec;
}

export interface HarnessTesterWorkspaceSnapshot {
  workspacePath: string;
  gitAvailable: boolean;
  changedFiles: string[];
  diff: string;
  diffSummary: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export interface HarnessTesterApiTraceSummary {
  available: boolean;
  sessionKey: string;
  eventCount: number;
  fatalErrors: number;
  schemaErrors: number;
  toolErrors: number;
  events?: unknown;
  error?: string;
}

export interface HarnessBehaviorSignal {
  flag: HarnessBehaviorFlag;
  owner: HarnessFailureOwner;
  severity: "info" | "warning" | "error";
  detail: string;
}

export interface HarnessTesterReport {
  run_id: string;
  task_id: string;
  task_name: string;
  benchmark: HarnessBenchmarkKind;
  harness_name: string;
  model: string;
  api_endpoint: string;
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  status: HarnessTesterStatus;
  setup_results: HarnessTesterCommandResult[];
  harness_result: HarnessTesterCommandResult;
  validation_results: HarnessTesterCommandResult[];
  changed_files: string[];
  diff_summary: HarnessTesterWorkspaceSnapshot["diffSummary"];
  native_scores: Record<string, number | string | boolean>;
  normalized_scores: {
    task_success?: number;
    tool_call_reliability?: number;
    patch_correctness?: number;
    instruction_following?: number;
    safety_score?: number;
    efficiency_score?: number;
  };
  behavioral_flags: HarnessBehaviorSignal[];
  api_trace_summary: HarnessTesterApiTraceSummary;
  harness_log_paths: string[];
  artifact_paths: string[];
  final_notes: string[];
}

export interface HarnessTesterRunOptions {
  task: HarnessTesterResolvedTask;
  harness: HarnessTesterAdapter;
  model: string;
  apiBaseUrl: string;
  apiKey?: string;
  artifactsRoot?: string;
  workRoot?: string;
  keepSuccessfulArtifacts?: boolean;
  dryRun?: boolean;
  adminUrl?: string;
  adminToken?: string;
  runId?: string;
  env?: Record<string, string>;
}
