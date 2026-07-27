import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import client from "./client";
import type {
  CapabilityMatrixEffective,
  CapabilitySelectorType,
  UserRuntimePreferences,
  UserRuntimePreferencesResponse,
  AccountUsageDashboard,
  AccountUsageSeriesEntry,
  AccountUsageSummary,
  UsageAuditRequest,
  UsageAuditResponse,
} from "../types";

type GetConfig = Parameters<typeof client.get>[1];
type WriteConfig = Parameters<typeof client.post>[2];

function unwrap<T>(request: Promise<{ data: T }>): Promise<T> {
  return request.then((r) => r.data);
}

function apiGet<T>(url: string, config?: GetConfig) {
  return unwrap(client.get<T>(url, config));
}

function apiPost<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.post<T>(url, data, config));
}

function apiPut<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.put<T>(url, data, config));
}

function apiDelete<T>(url: string, config?: GetConfig) {
  return unwrap(client.delete<T>(url, config));
}
// --- Usage (trace-backed) ---

export interface UsageTimeSeriesEntry {
  bucket: string;
  requests: number;
  total_tokens: number;
  tokens_in?: number;
  tokens_cached?: number;
  tokens_cache_write?: number;
  price_usd: number;
  no_cache_price_usd?: number;
  cache_discount_usd?: number;
  provider_actual_cost_usd?: number;
  avg_duration_ms: number;
  error_count: number;
}

export interface UsageSummary {
  period_hours: number;
  trace_count: number;
  total_tokens: number;
  tokens_in?: number;
  tokens_cached?: number;
  tokens_cache_write?: number;
  price_usd: number;
  no_cache_price_usd?: number;
  cache_discount_usd?: number;
  provider_actual_cost_usd?: number;
  avg_duration_ms: number;
  error_count: number;
  source?: string;
  note?: string;
}

export function useUsageSeries(sinceHours = 24) {
  return useQuery<UsageTimeSeriesEntry[]>({
    queryKey: ["usage", "series", sinceHours],
    queryFn: () => apiGet(`/usage?since_hours=${sinceHours}`),
    refetchInterval: 60_000,
  });
}

export function useUsageSummary(sinceHours = 24) {
  return useQuery<UsageSummary>({
    queryKey: ["usage", "summary", sinceHours],
    queryFn: () => apiGet(`/usage/summary?since_hours=${sinceHours}`),
    refetchInterval: 60_000,
  });
}

/** Account Usage — any authenticated user; planner_usage_log (+ trace fallback). */
export function useUsageMeSummary(sinceHours = 24) {
  return useQuery<AccountUsageSummary & { period_hours: number; price_basis: string }>({
    queryKey: ["usage", "me-summary", sinceHours],
    queryFn: () => apiGet(`/usage/me/summary?since_hours=${sinceHours}`),
    refetchInterval: 60_000,
  });
}

export function useUsageMeSeries(sinceHours = 24) {
  return useQuery<AccountUsageSeriesEntry[]>({
    queryKey: ["usage", "me-series", sinceHours],
    queryFn: () => apiGet(`/usage/me/series?since_hours=${sinceHours}`),
    refetchInterval: 60_000,
  });
}

export function useUsageMeDashboard(sinceHours = 24) {
  return useQuery<AccountUsageDashboard>({
    queryKey: ["usage", "me-dashboard", sinceHours],
    queryFn: () =>
      apiGet("/usage/me/dashboard", { params: { since_hours: sinceHours } }),
    refetchInterval: 60_000,
  });
}

export function useUsageMeRequests(sinceHours = 720, limit = 50, offset = 0) {
  return useQuery<UsageAuditResponse>({
    queryKey: ["usage", "me-requests", sinceHours, limit, offset],
    queryFn: () =>
      apiGet("/usage/me/requests", { params: { since_hours: sinceHours, limit, offset } }),
    refetchInterval: 60_000,
  });
}

export function useUsageMeRequest(requestId: string | undefined) {
  return useQuery<UsageAuditRequest>({
    queryKey: ["usage", "me-request", requestId],
    queryFn: () => apiGet(`/usage/me/requests/${requestId}`),
    enabled: Boolean(requestId),
  });
}

// --- Yarn Ops ---

export interface YarnOverview {
  since_hours: number;
  total_requests: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  total_price_usd: number;
  total_provider_actual_cost_usd?: number;
  avg_latency_ms: number;
  p99_latency_ms: number;
  error_count: number;
  error_rate: number;
  escalation_count: number;
  total_tool_calls: number;
  active_sessions: number;
}

export interface YarnPerformanceBucket {
  bucket: string | null;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  tokens_cache_write?: number;
  estimated_no_cache_cost_usd?: number;
  cache_savings_usd?: number;
  price_usd: number;
  provider_actual_cost_usd?: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  escalations: number;
  errors: number;
}

export interface YarnIntelligence {
  since_hours: number;
  requests: number;
  avg_tool_calls_per_request: number;
  cache_hit_estimate: number;
  tool_use_stop_rate: number;
  error_like_rate: number;
  trajectory_events: number;
  first_pass_verify_rate: number;
  verification_stall_rate: number;
  blind_retry_rate: number;
  patch_ratio: number;
  structured_error_coverage: number;
  completion_gate_blocked_rate: number;
  critic_block_rate: number;
  trajectory_bucket_counts: Record<string, number>;
  state_transition_quality: {
    trajectory_events: number;
    score_avg: number;
    score_observed_events: number;
    score_coverage: number;
    label_rates: {
      forward_progress: number;
      stalled: number;
      regressed: number;
      reground_required: number;
    };
    label_counts: {
      forward_progress: number;
      stalled: number;
      regressed: number;
      reground_required: number;
    };
    threshold_band_avg: {
      forward_progress_min: number;
      regressed_max: number;
    };
    global_scope_counts: Record<string, number>;
    global_scope_coverage: number;
    calibration_events: {
      local: number;
      global: number;
      latest_local_at: string | null;
      latest_global_at: string | null;
    };
    top_reasons: Array<{ reason: string; count: number }>;
    risk_flags: string[];
  };
  top_models: Array<{ model: string; requests: number; price_usd: number; provider_actual_cost_usd?: number }>;
  finish_reason_counts: Record<string, number>;
  edit_context_miss: {
    events: number;
    event_rate: number;
    impacted_requests: number;
    request_rate: number;
    mapped_requests: number;
    mapping_coverage: number;
    unmapped_requests: number;
    impacted_sessions: number;
    impacted_tokens: number;
    impacted_cached_tokens: number;
    impacted_cache_hit_estimate: number;
    impacted_price_usd: number;
    top_models: Array<{
      provider: string;
      model: string;
      requests: number;
      total_tokens: number;
      cached_tokens: number;
      price_usd: number;
    }>;
    top_files: Array<{
      file_path: string;
      miss_count: number;
    }>;
  };
}

export interface YarnTransitionQualityBucket {
  bucket: string | null;
  trajectory_events: number;
  quality_score_avg: number;
  quality_score_observed_events: number;
  quality_score_coverage: number;
  forward_progress_rate: number;
  stalled_rate: number;
  regressed_rate: number;
  reground_required_rate: number;
  global_scope_coverage: number;
  quality_forward_min_avg: number;
  quality_regressed_max_avg: number;
  local_calibration_events: number;
  global_calibration_events: number;
  risk_flags: string[];
}

export interface YarnTransitionQualitySummary {
  bucket_count: number;
  trajectory_events_total: number;
  quality_score_avg: number;
  quality_score_observed_events_total: number;
  quality_score_coverage_avg: number;
  regressed_rate_avg: number;
  reground_required_rate_avg: number;
  global_scope_coverage_avg: number;
  quality_forward_min_avg: number;
  quality_regressed_max_avg: number;
  local_calibration_events_total: number;
  global_calibration_events_total: number;
  risk_flags: string[];
}

export interface YarnTransitionQualityTelemetry {
  since_hours: number;
  bucket_minutes: number;
  summary: YarnTransitionQualitySummary;
  alert_thresholds: {
    regressed_rate_warn: number;
    reground_required_rate_warn: number;
    global_scope_coverage_warn: number;
    quality_score_warn: number;
    quality_score_coverage_warn: number;
  };
  top_quality_reasons: Array<{ reason: string; count: number }>;
  alert_buckets: YarnTransitionQualityBucket[];
  actions: string[];
  buckets: YarnTransitionQualityBucket[];
}

export interface YarnRuntimeTelemetry {
  timestamp: number;
  governance?: {
    enabled: boolean;
    polls?: number;
    updates?: number;
    errors?: number;
    rulesLoaded?: number;
    lastEtag?: string;
    lastFetchedAt?: number;
  };
  featureFlags?: {
    governance?: boolean;
    governanceBypass?: boolean;
    [key: string]: boolean | string | number | undefined | null;
  };
  validationNormalization?: {
    rawCharsTotal: number;
    normalizedCharsTotal: number;
    findingsTotal: number;
    tokensSavedEstimateTotal: number;
    artifactHandleCount: number;
    admissionDroppedCount: number;
    normalizedMessageCount: number;
    tierCAttemptCount?: number;
    tierCSuccessCount?: number;
    tierCFallbackCount?: number;
    tierCErrorCount?: number;
  };
  toolResultReduction?: {
    rawCharsTotal: number;
    reducedCharsTotal: number;
    reducedCount: number;
    shrunkCount: number;
    expandedCount: number;
    unchangedCount: number;
    netCharsSavedTotal: number;
    artifactHandleCount: number;
    tokensSavedEstimateTotal: number;
    fallbackToArtifactCount: number;
    reducerFailures: number;
    guidedTruncationCount?: number;
    taskPrunedCount?: number;
    taskPrunedLinesKept?: number;
    taskPrunedLinesDropped?: number;
    byFamily: Record<string, number>;
    lifecycle: Record<string, { lifecycle: string; successes: number; failures: number; lastError?: string }>;
  };
  sawtoothContext?: {
    compactionCount: number;
    totalCharsBefore: number;
    totalCharsAfter: number;
    compactionFailures: number;
  };
  toolSchemaPruning?: {
    requestsConsidered: number;
    requestsPruned: number;
    toolsPrunedTotal: number;
  };
}

export interface YarnSessionRow {
  id: number;
  session_key: string;
  user_id: string;
  user_display?: string;
  username: string | null;
  role: string | null;
  conversation_id: string | null;
  client_kind: string | null;
  provider: string | null;
  model: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  total_tokens_saved: number;
  total_price_usd: number;
  total_provider_actual_cost_usd?: number;
  request_count: number;
  escalation_count: number;
  created_at: string | null;
  last_active_at: string | null;
}

export interface YarnSessionRequestRow {
  id: number;
  request_id: string;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  tokens_saved_by_reduction: number;
  latency_ms: number;
  price_usd: number;
  provider_actual_cost_usd?: number;
  pricing_source: string;
  escalated: boolean;
  tool_calls_count: number;
  finish_reason: string | null;
  created_at: string | null;
}

export interface YarnSessionEventRow {
  id: number;
  event_kind: string;
  component: string;
  detail: string;
  request_id: string | null;
  metadata_json: Record<string, unknown> | null;
  created_at: string | null;
}

export interface YarnSessionDetailResponse {
  session: YarnSessionRow;
  requests: YarnSessionRequestRow[];
  events: YarnSessionEventRow[];
  integrity?: {
    usage_rows_total: number;
    session_request_count: number;
    truncated_to_session_request_count: boolean;
  };
}

export interface YarnEventRow {
  id: number;
  session_key: string;
  request_id: string;
  user_id: string;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  latency_ms: number;
  price_usd: number;
  provider_actual_cost_usd?: number;
  pricing_source: string;
  escalated: boolean;
  tool_calls_count: number;
  finish_reason: string | null;
  created_at: string | null;
}

export interface YarnHealthResult {
  name: string;
  status: string;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
  category: string;
}

export interface YarnVerifyCheck {
  check: string;
  status: string;
  status_code?: number;
  error?: string;
}

export interface YarnVerifyResult {
  overall: string;
  checks: YarnVerifyCheck[];
}

export interface YarnOptimizationFinding {
  severity: "info" | "warning" | "critical" | string;
  code: string;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  recommended_action: string;
}

export interface YarnOptimizationHealth {
  generated_at: string;
  status: "healthy" | "warn" | "critical" | "unknown" | string;
  summary: {
    sample_count: number;
    source: string;
    cache_hit_avg_pct: number;
    cache_hit_token_pct: number;
    latest_cache_hit_pct: number;
    prompt_tokens: number;
    cached_tokens: number;
    cache_creation_tokens: number;
    outcome_counts: Record<string, number>;
  };
  stability: Record<
    string,
    {
      observed: number;
      unique: number;
      latest_hash: string;
      avg_bytes: number;
      latest_bytes: number;
      stability_ratio: number;
    }
  >;
  stage_timings: Record<
    string,
    {
      samples: number;
      avg_ms: number;
      p95_ms: number;
      max_ms: number;
    }
  >;
  latest: {
    request_id?: string | null;
    path?: string | null;
    session_key?: string | null;
    cache_shape_outcome?: string | null;
    cache_hit_pct?: number;
    latency_ms?: number | null;
    finish_reason?: string | null;
    decision_path?: string | null;
  };
  findings: YarnOptimizationFinding[];
  next_actions: string[];
}

export interface YarnOptimizationWatcher extends YarnOptimizationHealth {
  watcher_report: {
    status: string;
    summary: string;
    findings: YarnOptimizationFinding[];
    next_actions: string[];
    model_assist_ready: boolean;
    model_assist_prompt: string;
  };
  ai_assist?: {
    status: string;
    response: string;
    model: string;
    tokens: number;
    source: string;
  };
}

export interface YarnModelArchitectureTrace {
  profile_id?: string;
  policy_hash?: string;
  provider?: string;
  mediation_mode?: string;
  apply_context_budget_policy?: boolean;
  apply_system_hint?: boolean;
  apply_governor_bias?: boolean;
  attention?: string;
  activation?: string;
  decoding?: string;
  declared_context_tokens?: number;
  effective_context_ceiling_tokens?: number;
  safe_instruction_tokens?: number;
  safe_tool_output_tokens?: number;
  long_tail_retention?: string;
  tool_calling_reliability?: string;
  long_context_reliability?: string;
  output_throughput_bias?: string;
  retry_sensitivity?: string;
  compaction_sensitivity?: string;
  compaction_mode?: string;
  prefer_memory_stitching?: boolean;
  prefer_recent_tool_state_replay?: boolean;
  prefer_structured_tool_digests?: boolean;
  prefer_explicit_state_headers?: boolean;
  prefer_deterministic_validation?: boolean;
  strict_stream_tool_boundary_validation?: boolean;
  reasons?: string[];
}

export interface YarnModelArchitectureDiagnostic {
  model_id: string;
  resolved: boolean;
  tier_id?: string;
  backend_model: string;
  provider?: string;
  adapter_family: string;
  declared_context_tokens?: number;
  override_applied: boolean;
  architecture: YarnModelArchitectureTrace;
  profile_notes?: string[];
}

export interface YarnModelArchitectureDiagnostics {
  schema_version: string;
  count: number;
  models: YarnModelArchitectureDiagnostic[];
}

export function useYarnOverview(sinceHours: number) {
  return useQuery<YarnOverview>({
    queryKey: ["yarn", "overview", sinceHours],
    queryFn: () =>
      apiGet("/yarn/overview", { params: { since_hours: sinceHours } }),
    refetchInterval: 60_000,
  });
}

export function useUserRuntimePreferences(enabled = true) {
  return useQuery<UserRuntimePreferencesResponse>({
    queryKey: ["yarn", "runtime-preferences"],
    queryFn: () => apiGet("/yarn/runtime-preferences"),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useUpdateUserRuntimePreferences() {
  const qc = useQueryClient();
  return useMutation<UserRuntimePreferencesResponse, Error, UserRuntimePreferences>({
    mutationFn: (data: UserRuntimePreferences) =>
      apiPut("/yarn/runtime-preferences", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["yarn", "runtime-preferences"] });
    },
  });
}

export function useYarnPerformance(sinceHours: number, bucketMinutes = 15) {
  return useQuery<YarnPerformanceBucket[]>({
    queryKey: ["yarn", "performance", sinceHours, bucketMinutes],
    queryFn: () =>
      apiGet("/yarn/performance", {
          params: { since_hours: sinceHours, bucket_minutes: bucketMinutes },
        }),
    refetchInterval: 60_000,
  });
}

export function useYarnIntelligence(sinceHours: number) {
  return useQuery<YarnIntelligence>({
    queryKey: ["yarn", "intelligence", sinceHours],
    queryFn: () =>
      apiGet("/yarn/intelligence", { params: { since_hours: sinceHours } }),
    refetchInterval: 60_000,
  });
}

export function useYarnOptimizationWatcher() {
  return useQuery<YarnOptimizationWatcher>({
    queryKey: ["yarn", "optimization-watcher"],
    queryFn: () => apiGet("/yarn/optimization-watcher"),
    refetchInterval: 60_000,
  });
}

export function useYarnOptimizationAssist() {
  return useMutation<YarnOptimizationWatcher, Error, { focus?: string }>({
    mutationFn: (data) => apiPost("/yarn/optimization-watcher/assist", data),
  });
}

export function useYarnModelArchitectureDiagnostics() {
  return useQuery<YarnModelArchitectureDiagnostics>({
    queryKey: ["yarn", "model-architecture"],
    queryFn: () => apiGet("/yarn/model-architecture"),
    refetchInterval: 60_000,
  });
}

export function useYarnTransitionQualityTelemetry(sinceHours: number, bucketMinutes = 60) {
  return useQuery<YarnTransitionQualityTelemetry>({
    queryKey: ["yarn", "transition-quality", sinceHours, bucketMinutes],
    queryFn: () =>
      apiGet("/yarn/transition-quality", {
          params: { since_hours: sinceHours, bucket_minutes: bucketMinutes },
        }),
    refetchInterval: 60_000,
  });
}

export function useYarnRuntimeTelemetry() {
  return useQuery<YarnRuntimeTelemetry>({
    queryKey: ["yarn", "runtime-telemetry"],
    queryFn: () => apiGet("/yarn/runtime-telemetry"),
    refetchInterval: 30_000,
  });
}

export interface YarnReducerTelemetryRollup {
  reduced_count_delta: number;
  reducer_failures_delta: number;
  tokens_saved_estimate_delta: number;
  fallback_to_artifact_delta: number;
  guided_truncation_delta: number;
  task_pruned_delta: number;
  task_pruned_lines_kept_delta: number;
  task_pruned_lines_dropped_delta: number;
  /** Monotonic deltas on toolResultReduction.rawCharsTotal between snapshots */
  raw_chars_delta: number;
  /** Monotonic deltas on toolResultReduction.reducedCharsTotal */
  reduced_chars_delta: number;
  /** Monotonic deltas on toolResultReduction.netCharsSavedTotal */
  net_chars_saved_delta: number;
  lifecycle: Record<string, { success_delta: number; fail_delta: number }>;
}

export interface YarnReducerTelemetryCumulative {
  reduced_count_total: number;
  reducer_failures_total: number;
  tokens_saved_estimate_total: number;
  fallback_to_artifact_total: number;
  guided_truncation_total: number;
  task_pruned_total: number;
  task_pruned_lines_kept_total: number;
  task_pruned_lines_dropped_total: number;
  /** Restart-tolerant sum of raw chars processed (from persisted telemetry) */
  raw_chars_total: number;
  reduced_chars_total: number;
  net_chars_saved_total: number;
  lifecycle: Record<string, { success_total: number; fail_total: number }>;
}

export interface YarnReducerTelemetryScrapeStatus {
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  stale: boolean;
}

export interface YarnReducerTelemetryHistory {
  since_hours: number;
  snapshot_count: number;
  rollup: YarnReducerTelemetryRollup;
  cumulative: YarnReducerTelemetryCumulative;
  latest_snapshot_at: string | null;
  stale: boolean;
  scrape_status?: YarnReducerTelemetryScrapeStatus;
  recent_snapshots: Array<{ captured_at: string | null; payload: Record<string, unknown> }>;
}

export function useYarnReducerTelemetryHistory(sinceHours: number) {
  return useQuery<YarnReducerTelemetryHistory>({
    queryKey: ["yarn", "reducer-telemetry-history", sinceHours],
    queryFn: () =>
      apiGet("/yarn/reducer-telemetry-history", { params: { since_hours: sinceHours } }),
    refetchInterval: 60_000,
  });
}

export function useYarnSessions(page: number, pageSize: number, activeSinceHours = 168) {
  return useQuery<{ sessions: YarnSessionRow[]; total: number }>({
    queryKey: ["yarn", "sessions", page, pageSize, activeSinceHours],
    queryFn: () =>
      apiGet("/yarn/sessions", { params: { page, page_size: pageSize, active_since_hours: activeSinceHours } }),
    placeholderData: keepPreviousData,
  });
}

export function useYarnSessionDetail(sessionKey: string | undefined) {
  return useQuery<YarnSessionDetailResponse>({
    queryKey: ["yarn", "session", sessionKey],
    queryFn: () =>
      apiGet(`/yarn/sessions/${encodeURIComponent(sessionKey!)}`),
    enabled: Boolean(sessionKey),
  });
}

export interface YarnPurgeResult {
  dry_run: boolean;
  delete_after_archive?: boolean;
  session_keys?: number;
  sessions: number;
  usage_rows: number;
  events: number;
  safety_events?: number;
  archive?: { archive_id: string; bucket: string; key: string; record_count: number; bytes: number } | null;
  deleted?: {
    sessions: number;
    usage_rows: number;
    events: number;
    safety_events: number;
  } | null;
}

export function useYarnSessionsPurge() {
  const qc = useQueryClient();
  return useMutation<
    YarnPurgeResult,
    Error,
    { older_than_days: number; session_key_prefix?: string; dry_run: boolean; archive_before_delete?: boolean }
  >({
    mutationFn: (params) =>
      apiPost("/yarn/sessions/purge", null, { params }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["yarn"] });
    },
  });
}

export function useYarnSessionsArchive() {
  const qc = useQueryClient();
  return useMutation<
    YarnPurgeResult,
    Error,
    {
      session_keys?: string[];
      older_than_days?: number;
      session_key_prefix?: string;
      dry_run?: boolean;
      delete_after_archive?: boolean;
    }
  >({
    mutationFn: (data) => apiPost("/yarn/sessions/archive", data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["yarn"] });
    },
  });
}

export function useYarnSessionsBulkDelete() {
  const qc = useQueryClient();
  return useMutation<
    { requested: number; session_keys: number; sessions: number; usage_rows: number; events: number; safety_events: number },
    Error,
    string[]
  >({
    mutationFn: (sessionKeys) =>
      apiPost("/yarn/sessions/bulk-delete", { session_keys: sessionKeys }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["yarn"] });
    },
  });
}

export function useYarnEvents(
  page: number,
  pageSize: number,
  sinceHours: number,
  errorsOnly: boolean,
) {
  return useQuery<{ events: YarnEventRow[]; total: number }>({
    queryKey: ["yarn", "events", page, pageSize, sinceHours, errorsOnly],
    queryFn: () =>
      apiGet("/yarn/events", {
          params: {
            page,
            page_size: pageSize,
            since_hours: sinceHours,
            errors_only: errorsOnly,
          },
        }),
    placeholderData: keepPreviousData,
  });
}

export function useYarnHealth() {
  return useQuery<YarnHealthResult>({
    queryKey: ["yarn", "health"],
    queryFn: () => apiGet("/yarn/health"),
    refetchInterval: 30_000,
  });
}

export function useYarnVerify() {
  const qc = useQueryClient();
  return useMutation<YarnVerifyResult>({
    mutationFn: () => apiPost("/yarn/verify"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["yarn", "health"] });
    },
  });
}

// --- Yarn User Usage ---

export interface YarnUserUsage {
  user_id: string;
  since_hours: number;
  total_requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  tokens_cache_write?: number;
  price_usd: number;
  no_cache_price_usd?: number;
  cache_discount_usd?: number;
  avg_latency_ms: number;
  escalations: number;
  errors: number;
}

export function useYarnUserUsage(sinceHours = 720) {
  return useQuery<YarnUserUsage>({
    queryKey: ["yarn", "user-usage", sinceHours],
    queryFn: () =>
      apiGet("/yarn/user-usage", { params: { since_hours: sinceHours } }),
    refetchInterval: 120_000,
  });
}

// --- Security / Guardrails ---

export interface SecurityEventRow {
  id: number;
  event_id: string;
  created_at: string | null;
  event_type: string;
  severity: string;
  confidence: number;
  confidence_band: string;
  action_taken: string;
  scope: string;
  service: string;
  request_id: string;
  session_id: string;
  user_id: string;
  token_id: string;
  org_id: string;
  patterns_found: string[];
  excerpt: string;
  scanner_name: string;
  latency_ms: number;
  detail: Record<string, unknown>;
  resolved: boolean;
  resolved_by: string;
  resolved_action: string;
  resolved_reason: string;
  resolved_at: string | null;
}

export interface SecuritySummary {
  total: number;
  unresolved: number;
  by_severity: Record<string, number>;
  by_type: Record<string, number>;
  since_hours: number;
}

export function useSecurityEvents(params: {
  limit?: number;
  before_id?: number;
  severity?: string | undefined;
  event_type?: string | undefined;
  service?: string | undefined;
  resolved?: boolean | undefined;
  since_hours?: number;
}) {
  return useQuery<{ events: SecurityEventRow[] }>({
    queryKey: ["security", "events", params],
    queryFn: () =>
      apiGet("/security/events", { params }),
    refetchInterval: 30_000,
  });
}

export function useSecuritySummary(sinceHours: number) {
  return useQuery<SecuritySummary>({
    queryKey: ["security", "summary", sinceHours],
    queryFn: () =>
      apiGet("/security/summary", { params: { since_hours: sinceHours } }),
    refetchInterval: 30_000,
  });
}

export function useResolveSecurityEvent() {
  const qc = useQueryClient();
  return useMutation<
    SecurityEventRow,
    Error,
    { event_id: string; action: string; reason: string }
  >({
    mutationFn: ({ event_id, ...body }) =>
      apiPost(`/security/events/${event_id}/resolve`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["security"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Authorization / OpenFGA
// ---------------------------------------------------------------------------

export interface AuthzStatus {
  engine: string;
  evaluations: number;
  rejections: number;
  openfga_configured: boolean;
  recent_events: Array<{
    trace_id: string;
    resource: string;
    action: string;
    allow: boolean;
    matched_rules: string[];
    user_id: string;
    timestamp: number;
  }>;
  store: { store_id: string; api_url: string } | null;
  latest_model: { id: string; type_definitions_count: number } | null;
}

export function useAuthzStatus() {
  return useQuery<AuthzStatus>({
    queryKey: ["authz", "status"],
    queryFn: () => apiGet("/authz/status"),
    refetchInterval: 15_000,
  });
}

export interface AuthzTuple {
  user: string;
  relation: string;
  object: string;
  timestamp?: string;
}

export function useAuthzTuples(filters: { user?: string; relation?: string; object?: string }) {
  return useQuery<{ tuples: AuthzTuple[]; count: number }>({
    queryKey: ["authz", "tuples", filters],
    queryFn: () => apiGet("/authz/tuples", { params: filters }),
  });
}

export function useWriteAuthzTuple() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { user: string; relation: string; object: string }) =>
      apiPost("/authz/tuples", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["authz"] });
    },
  });
}

export function useDeleteAuthzTuple() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { user: string; relation: string; object: string }) =>
      apiDelete("/authz/tuples", { data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["authz"] });
    },
  });
}

export interface AuthzCheckResult {
  user: string;
  relation: string;
  object: string;
  allowed: boolean;
}

export function useRunAuthzCheck() {
  return useMutation<AuthzCheckResult, Error, { user: string; relation: string; object: string }>({
    mutationFn: (data) => apiPost("/authz/check", data),
  });
}

export interface AuthzUserPermissions {
  user_id: string;
  fga_user: string;
  direct_tuples: AuthzTuple[];
  computed_checks: Record<string, boolean>;
}

export function useAuthzUserPermissions(userId: string) {
  return useQuery<AuthzUserPermissions>({
    queryKey: ["authz", "user-permissions", userId],
    queryFn: () => apiGet(`/authz/user-permissions/${userId}`),
    enabled: !!userId,
  });
}

export interface AuthzSchemaType {
  type: string;
  relations: Record<string, { directly_related: string[] }>;
}

export function useAuthzSchemaTypes() {
  return useQuery<{ types: AuthzSchemaType[]; model_id: string | null }>({
    queryKey: ["authz", "schema-types"],
    queryFn: () => apiGet("/authz/schema-types"),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Model Policies — conditional model selection rules
// ---------------------------------------------------------------------------

export interface PolicyRule {
  id?: number;
  role?: string;
  priority: number;
  condition_type: string;
  condition_value: string;
  model: string;
  label: string;
  enabled: boolean;
}

export function useModelPolicies() {
  return useQuery<{ policies: Record<string, PolicyRule[]> }>({
    queryKey: ["models", "policies"],
    queryFn: () => apiGet("/models/policies"),
    refetchInterval: 30_000,
  });
}

export function useRolePolicies(role: string) {
  return useQuery<{ role: string; rules: PolicyRule[]; preview: Record<string, string> }>({
    queryKey: ["models", "policies", role],
    queryFn: () => apiGet(`/models/policies/${role}`),
    enabled: !!role,
  });
}

export function useSaveRolePolicies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, rules }: { role: string; rules: Omit<PolicyRule, "id">[] }) =>
      apiPut(`/models/policies/${role}`, rules),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "policies"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "graph"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteRolePolicies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: string) =>
      apiDelete(`/models/policies/${role}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "policies"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "graph"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export interface EffortRecommendationPreviewRequest {
  prompt: string;
  effort_mode?: "auto" | "pulse" | "core" | "horizon" | null;
  include_frame?: boolean;
  operational_health?: number | null;
}

export interface EffortRecommendationPreviewResponse {
  requested_mode: "auto" | "pulse" | "core" | "horizon";
  selected_mode: "pulse" | "core" | "horizon";
  recommendation: {
    recommended_mode: "pulse" | "core" | "horizon";
    confidence: number;
    reasons: string[];
    routing_signals: {
      complexity: number;
      ambiguity: number;
      risk: number;
      scope: number;
      user_intent: number;
      operational_health: number;
    };
  };
  classification: Record<string, unknown>;
  policy: {
    retrieval_depth: number;
    tool_budget: number;
    critique_passes: number;
    planner_depth: number;
    context_budget: number;
    graph_variant: string;
    response_depth: string;
  };
}

export function useEffortRecommendationPreview() {
  return useMutation<EffortRecommendationPreviewResponse, Error, EffortRecommendationPreviewRequest>({
    mutationFn: (data) => apiPost("/models/effort/recommend", data),
  });
}

/* ── Language Packs ──────────────────────────────────────────────────────── */

export interface LanguagePackConformance {
  language: string;
  displayName: string;
  version: string;
  familyCount: number;
  classifierCount: number;
  reducerCount: number;
  fastPathPatternCount: number;
  verificationCommandCount: number;
  fixRecipeCount: number;
  classifierCoverage: number;
  reducerCoverage: number;
}

export function useYarnLanguagePacks() {
  return useQuery<{ languagePacks: LanguagePackConformance[] }>({
    queryKey: ["yarn", "language-packs"],
    queryFn: () => apiGet("/yarn/language-packs"),
    refetchInterval: 60_000,
  });
}

/* ── Capability Matrix ───────────────────────────────────────────────────── */

const CAPABILITY_MATRIX_QUERY_KEY = ["governance", "capability-matrix"] as const;

export function useCapabilityMatrix(orgId?: string) {
  return useQuery<CapabilityMatrixEffective>({
    queryKey: [...CAPABILITY_MATRIX_QUERY_KEY, orgId ?? "platform"],
    queryFn: () =>
      apiGet("/governance/capability-matrix/effective", { params: orgId ? { org_id: orgId } : undefined }),
    refetchInterval: 30_000,
  });
}

export function useUpdateCapabilityMatrixGlobal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      mode: "enforced" | "shadow";
      global_optimizations_enabled: boolean;
      org_id?: string;
    }) => apiPut("/governance/capability-matrix/global", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CAPABILITY_MATRIX_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export interface CapabilityMatrixOverrideUpsertInput {
  name?: string;
  org_id?: string;
  scope?: string;
  scope_value?: string;
  enabled: boolean;
  selector_type: CapabilitySelectorType;
  selector: string;
  priority?: number;
  capabilities: Record<string, boolean>;
}

export function useCreateCapabilityMatrixOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CapabilityMatrixOverrideUpsertInput) =>
      apiPost("/governance/capability-matrix/overrides", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CAPABILITY_MATRIX_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdateCapabilityMatrixOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ policyId, ...payload }: CapabilityMatrixOverrideUpsertInput & { policyId: string }) =>
      apiPut(`/governance/capability-matrix/overrides/${policyId}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CAPABILITY_MATRIX_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteCapabilityMatrixOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) =>
      apiDelete(`/governance/capability-matrix/overrides/${policyId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CAPABILITY_MATRIX_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}
