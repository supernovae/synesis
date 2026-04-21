import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  SYNESIS_YARN_ADMIN_API_URL: z.string().default("http://synesis-admin.synesis-admin.svc.cluster.local:8080"),
  SYNESIS_INTERNAL_SERVICE_TOKEN: z.string().optional(),
  SYNESIS_YARN_TIER_POLL_INTERVAL: z.coerce.number().default(60),
  SYNESIS_YARN_DEFAULT_TIER: z.string().default("synesis-core"),
  SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  SYNESIS_YARN_OPENAI_COMPAT_API_KEY: z.string().default(""),
  SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: z.coerce.number().default(12),
  SYNESIS_YARN_SESSION_REDIS_URL: z.string().default("redis://localhost:6379/3"),
  // deploy.sh stores SQLAlchemy async URLs in synesis-admin-db-url; node-pg rejects +asyncpg
  SYNESIS_YARN_ADMIN_DB_URL: z
    .string()
    .default("")
    .transform((v) => {
      const t = (v ?? "").trim();
      if (!t) return "";
      return t.replace(/^postgresql\+asyncpg:\/\//i, "postgresql://");
    }),
  SYNESIS_PAT_PEPPER: z.string().default(""),
  SYNESIS_OPENFGA_API_URL: z.string().default(""),
  SYNESIS_OPENFGA_STORE_ID: z.string().default(""),
  SYNESIS_OPENFGA_MODEL_ID: z.string().default(""),
  SYNESIS_OPENFGA_AUTH_TOKEN: z.string().default(""),
  SYNESIS_YARN_DB_POOL_MAX: z.coerce.number().default(20),
  SYNESIS_YARN_DB_POOL_IDLE_MS: z.coerce.number().default(30000),
  SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: z.coerce.number().default(3000),
  SYNESIS_YARN_WRITE_QUEUE_MAX: z.coerce.number().default(10000),
  SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: z.coerce.number().default(50),
  SYNESIS_YARN_SESSION_TTL_MS: z.coerce.number().default(14_400_000),
  SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: z.coerce.number().default(48_000),
  SYNESIS_YARN_TOOL_OUTPUT_TRIM_GUIDED_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_TOOL_OUTPUT_TRIM_MAX_LINES: z.coerce.number().default(50),
  SYNESIS_YARN_TOOL_OUTPUT_TRIM_PREVIEW_LINES: z.coerce.number().default(20),
  SYNESIS_YARN_TASK_PRUNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_TASK_PRUNING_MIN_LINES: z.coerce.number().default(80),
  SYNESIS_YARN_TASK_PRUNING_KEEP_MAX_LINES: z.coerce.number().default(30),
  SYNESIS_YARN_TASK_PRUNING_CONTEXT_RADIUS: z.coerce.number().default(1),
  SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT: z.coerce.number().default(8),
  SYNESIS_YARN_VALIDATION_MAX_FINDINGS: z.coerce.number().default(30),
  SYNESIS_YARN_VALIDATION_INCLUDE_RAW: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_VALIDATION_TIER_C_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_VALIDATION_TIER_C_ROLE: z.string().default("coder-normalizer"),
  SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS: z.coerce.number().default(1500),
  SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS: z.coerce.number().default(24000),
  SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS: z.coerce.number().default(8),
  SYNESIS_YARN_REDUCERS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_REDUCER_DISABLED_FAMILIES: z
    .string()
    .default(""),
  SYNESIS_YARN_REDUCER_MIN_CONFIDENCE: z.coerce.number().default(0.6),
  SYNESIS_YARN_REDUCER_PROFILE: z
    .enum(["balanced", "aggressive", "ultra"])
    .default("balanced"),
  SYNESIS_YARN_WORKING_FRAME_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_PROJECT_MANIFEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_FRAME_MAX_FILES: z.coerce.number().default(12),
  SYNESIS_YARN_MANIFEST_TEMPLATES_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_STRUCTURAL_CRITIC_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_MCP_TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_PERSIST_USAGE_TO_DB: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Safety limits
  SYNESIS_YARN_POLICY_HARD_REJECT_AFTER: z.coerce.number().default(6),
  /** Policy limit for session input tokens (governance may lower). Enforced mode rejects above this. */
  SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS: z.coerce.number().default(2_000_000),
  /** Hard safety ceiling — always reject above this in both modes. */
  SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS: z.coerce.number().default(2_000_000),
  /** `audit`: warn above policy soft limit but allow until hard max; `enforced`: reject at policy limit. */
  SYNESIS_YARN_SESSION_BUDGET_MODE: z.enum(["audit", "enforced"]).default("enforced"),
  /** Outbound model-admission mode based on estimated prompt+tool schema footprint. */
  SYNESIS_YARN_CONTEXT_ADMISSION_MODE: z
    .enum(["advisory", "hybrid", "enforced"])
    .default("hybrid"),
  /** Advisory threshold for estimated outbound input tokens (0 disables warning threshold). */
  SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS: z.coerce.number().default(120_000),
  /** Hard safety threshold for estimated outbound input tokens (0 disables hard admission reject). */
  SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS: z.coerce.number().default(180_000),
  /** When > 0, cap `maxOutputTokens` sent to the provider (runaway output safety). 0 = disabled. */
  SYNESIS_YARN_MAX_OUTPUT_TOKENS_SAFETY_CEILING: z.coerce.number().default(0),
  SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT: z.coerce.number().default(25),
  SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT: z.coerce.number().default(15),
  SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT: z.coerce.number().default(8),
  SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT: z.coerce.number().default(4),
  SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_QWEN_STAGNATION_WINDOW: z.coerce.number().default(8),
  SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD: z.coerce.number().default(3),
  SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT: z.coerce.number().default(4),
  SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT: z.coerce.number().default(3),
  SYNESIS_YARN_QWEN_RESUME_NUDGE_COOLDOWN_TURNS: z.coerce.number().default(2),
  SYNESIS_YARN_GOVERNANCE_PROFILE: z
    .enum(["safety_strict", "balanced_completion", "strict_control"])
    .default("balanced_completion"),

  // Per-user rate limiting (sliding window)
  SYNESIS_YARN_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  SYNESIS_YARN_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(30),
  // Hourly token throttle (warn-only by default; complements request-rate limiting)
  SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS: z.coerce.number().default(3_600_000),
  SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT: z.coerce.number().default(10_000_000),
  SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT: z.coerce.number().default(20_000_000),

  // Circuit breaker for model providers
  SYNESIS_YARN_BREAKER_FAILURE_THRESHOLD: z.coerce.number().default(5),
  SYNESIS_YARN_BREAKER_RECOVERY_TIMEOUT_MS: z.coerce.number().default(60_000),
  SYNESIS_YARN_BREAKER_HALF_OPEN_MAX: z.coerce.number().default(1),

  // Diagnostics ring buffer
  SYNESIS_YARN_DIAGNOSTIC_RING_MAX: z.coerce.number().default(100),

  // Artifact store bounds (memory safety when feature is enabled)
  SYNESIS_YARN_ARTIFACT_MAX_COUNT: z.coerce.number().default(500),
  SYNESIS_YARN_ARTIFACT_TTL_MS: z.coerce.number().default(3_600_000),
  SYNESIS_YARN_ARTIFACT_MAX_PAYLOAD_BYTES: z.coerce.number().default(5_242_880),

  // Policy engine repeat-map bounds (memory safety)
  SYNESIS_YARN_POLICY_REPEAT_MAP_MAX: z.coerce.number().default(5000),
  SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS: z.coerce.number().default(1_800_000),

  // Task intake + plan graph governance
  SYNESIS_YARN_TASK_INTAKE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_PLAN_GRAPH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES: z
    .string()
    .default("qwen3-coder")
    .transform((v) => v.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)),
  SYNESIS_YARN_GOVERNANCE_DISABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  /** Enable the provider-agnostic prefix optimizer (stable-first message layout; now "none" markers
   * after DashScope removal to enable full vLLM KV cache reporting). */
  SYNESIS_YARN_PREFIX_OPTIMIZER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_MODEL_SELECTION_MODE: z
    .enum(["respect_explicit", "preference", "lock"])
    .default("respect_explicit"),
  SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),

  // Eval Gym — observer and API routes
  SYNESIS_YARN_EVAL_OBSERVER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_EVAL_API_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Session lifecycle — auto-rotate when no conversation_id and idle > threshold
  SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS: z.coerce.number().default(30 * 60 * 1000),

  // M10 feature flags (individual kill-switches for bisecting regressions)
  SYNESIS_YARN_STABLE_PREFIX_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_JSON_COMPACTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  /** Planner base URL for knowledge search (shared with synesis-mcp-ts tool handlers). */
  SYNESIS_YARN_PLANNER_URL: z.string().default(
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
  ),
  SYNESIS_YARN_CRITIC_URL: z.string().default(
    "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1",
  ),
  SYNESIS_YARN_CRITIC_MODEL: z.string().default("synesis-critic"),
  SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_WEB_SEARCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS: z.coerce.number().default(200),
  SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_GOVERNANCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_GOVERNANCE_POLL_INTERVAL_S: z.coerce.number().default(60),
  SYNESIS_YARN_SESSION_CONTINUITY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Phase 15: Conversation memory — durable continuity persistence to Postgres
  SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_RECALL_MAX_AGE_MS: z.coerce.number().default(7 * 24 * 60 * 60 * 1000),

  SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Transcript pruning — evict stale tool results and condense old turns
  SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS: z.coerce.number().default(5),
  /** Max recent tool results kept at full fidelity; fallback for single-turn agent loops. 0 disables. */
  SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS: z.coerce.number().default(25),
  SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS: z.coerce.number().default(60_000),
  SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS: z.coerce.number().default(400),
  SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS: z.coerce.number().default(2000),
  /** When true, store superseded/pruned tool bytes in ArtifactStore and embed artifact_handle on stubs (H2). */
  SYNESIS_YARN_TRANSCRIPT_PRUNE_ARTIFACT_RETENTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  /**
   * Max UTF-8 bytes per tool message body after JSON parse. 0 = disabled.
   * Replaces oversized tool results before reducer to avoid OOM on huge logs.
   */
  SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES: z.coerce.number().default(0),

  // Harness telemetry — structured logs for lossy ops (prune, trim, ingress cap, interventions)
  SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Recall engine — confidence-based bypass / enrichment
  SYNESIS_YARN_RECALL_BYPASS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_RECALL_BYPASS_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.8),
  SYNESIS_YARN_RECALL_ENRICH_THRESHOLD: z.coerce.number().default(0.4),
  SYNESIS_YARN_EVIDENCE_CONFIDENCE_MIN: z.coerce.number().default(0.3),

  // Verification loop — language-pack-driven verification guidance
  SYNESIS_YARN_VERIFICATION_PLAN_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_VERIFICATION_MAX_ROUNDS: z.coerce.number().default(3),
  SYNESIS_YARN_VERIFICATION_BUDGET_MS: z.coerce.number().default(30_000),

  // Completion fidelity gate — avoid claiming completion while must-have requirements are missing.
  SYNESIS_YARN_COMPLETION_GATE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  /** When true (default), do not replace assistant text with partial-completion message during clarification-style turns. */
  SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  /** When true, completion gate also blocks finalization if verification tool outputs contain blocking failures. */
  SYNESIS_YARN_COMPLETION_GATE_BLOCK_VERIFICATION: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  /** If completion is blocked by verification failure, suggest one bounded cleanup pass before next finalize attempt. */
  SYNESIS_YARN_COMPLETION_GATE_BOUNDED_CLEANUP_PASS: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  /** Deterministic pre-finalization critic pass on end-turn responses. */
  SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  /** Optional cheap LLM critic fallback when deterministic critic blocks completion. */
  SYNESIS_YARN_PREFINALIZE_LLM_CRITIC_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  /** Route planning-phase sessions to synesis-horizon (inference path). Default true. Set false for keyword-only horizon on planning. */
  SYNESIS_YARN_PLANNING_USE_HORIZON: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Response style flavor — markdown guidance + optional guardrail normalization.
  SYNESIS_YARN_RESPONSE_STYLE_MODE: z
    .enum(["off", "guidance", "guardrail"])
    .default("guidance"),
  SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Decision matrix — evidence-aware four-path routing (Phase 8)
  SYNESIS_YARN_DECISION_MATRIX_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_DETERMINISTIC_PATH_THRESHOLD: z.coerce.number().default(0.85),
  SYNESIS_YARN_CONSTRAINED_PATH_THRESHOLD: z.coerce.number().default(0.5),
  SYNESIS_YARN_ABSTAIN_EVIDENCE_FLOOR: z.coerce.number().default(0.2),
  SYNESIS_YARN_ESCALATION_FAILED_VERIF_LIMIT: z.coerce.number().default(2),

  // Claude compat
  SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE: z
    .enum(["disable", "passthrough"])
    .default("disable"),
  /** Optional JSON object: substring needle → synesis tier (checked before built-in haiku/sonnet/opus rules). */
  SYNESIS_YARN_CLAUDE_TIER_MAP: z
    .string()
    .optional()
    .transform((v) => {
      type Tier = "synesis-pulse" | "synesis-core" | "synesis-horizon";
      const s = (v ?? "").trim();
      if (!s) return {} as Record<string, Tier>;
      try {
        const o = JSON.parse(s) as Record<string, unknown>;
        const out: Record<string, Tier> = {};
        const valid = new Set<Tier>(["synesis-pulse", "synesis-core", "synesis-horizon"]);
        for (const [k, val] of Object.entries(o)) {
          if (typeof val === "string" && valid.has(val as Tier)) {
            out[k] = val as Tier;
          }
        }
        return out;
      } catch {
        return {} as Record<string, Tier>;
      }
    }),
  SYNESIS_YARN_JITTER_BUFFER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_SORTED_TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE: z.coerce.number().default(0),
  SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_OPENCLAW_MCP_ALLOWLIST_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP: z.coerce.number().default(8),

  // Trust / injection scan
  SYNESIS_YARN_TRUST_PACKET_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_INJECTION_SCAN_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_INJECTION_SCAN_ACTION: z
    .enum(["log", "reduce", "block"])
    .default("log"),
  SYNESIS_YARN_SECURITY_INGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // OTEL tracing
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().default("synesis-yarn-ts"),
  SYNESIS_YARN_OTEL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),

  // Stream admission (global per-pod concurrency + overflow queue)
  SYNESIS_YARN_MAX_CONCURRENT_STREAMS: z.coerce.number().default(50),
  SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH: z.coerce.number().default(100),
  SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS: z.coerce.number().default(30_000),
  SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().default(15_000),
  SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS: z.coerce.number().default(45_000),

  // Reliability hardening (Phase 11)
  SYNESIS_YARN_AUTH_POOL_MAX: z.coerce.number().default(5),
  SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS: z.coerce.number().default(30_000),
  SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS: z.coerce.number().default(8000),
  SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S: z.coerce.number().default(86400),
  SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS: z.coerce.number().default(60_000),

  // Sensemaking — future-backward exploration engine (Phase 10)
  SYNESIS_YARN_SENSEMAKING_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_SENSEMAKING_HARD_STOP_ONLY: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD: z.coerce.number().default(0.5),

  // Worker thread pool (Phase 16) — offload CPU-bound enrichment to separate cores
  SYNESIS_YARN_WORKER_POOL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_WORKER_POOL_SIZE: z.coerce.number().default(0),
  SYNESIS_YARN_WORKER_TASK_TIMEOUT_MS: z.coerce.number().default(5000),

  // Pattern recall — compositional pattern library (Phase 19)
  SYNESIS_YARN_PATTERN_RECALL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_PATTERN_USAGE_FEEDBACK_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),

  // Tool call collapsing (Synesis batch tools; opt-in client + /v1/coder/tool-collapse/plan)
  SYNESIS_YARN_TOOL_COLLAPSE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_TOOL_COLLAPSE_DEBOUNCE_MS: z.coerce.number().default(100),
  SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST: z
    .string()
    .default(
      "^npm test$|^pnpm test$|^yarn test$|^pytest\\s|^go test\\s|^cargo test\\s|^npm run build$|^pnpm build$|^yarn build$|^go build\\s|^cargo build\\s|^npm run lint$|^pnpm lint$|^yarn lint$|^ruff check\\s|^npm run format$|^pnpm format$|^yarn format$|^ruff format\\s",
    ),

  // Dedupe layer (exact + segment semantic + response cache; runs before linear collapse when enabled)
  SYNESIS_YARN_DEDUPE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() === "true"),
  SYNESIS_YARN_DEDUPE_CACHE_MAX: z.coerce.number().default(512),
  SYNESIS_YARN_DEDUPE_MAX_SEARCH_QUERY_CHARS: z.coerce.number().default(4096),

  // Response dedupe: wrap identical tool results with compact stubs (wired into main pipeline)
  SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  // Broad response dedupe: extend beyond read/search to list_files, glob, etc.
  SYNESIS_YARN_RESPONSE_DEDUPE_BROAD_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),

  // Historical content normalization (timestamps, paths, tool IDs in old messages)
  SYNESIS_YARN_HISTORICAL_NORMALIZE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Tool prefix cache (LRU tool results after collapse; wraps executor only)
  SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() === "true"),
  SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRIES: z.coerce.number().default(512),
  SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRY_BYTES: z.coerce.number().default(262_144),

  // Debug / trace
  SYNESIS_YARN_DEBUG_PROTOCOL: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_ENVELOPE_UNWRAP_LOG_SAMPLE_RATE: z.coerce.number().default(0.1).transform((v) => {
    if (!Number.isFinite(v)) return 0.1;
    return Math.min(1, Math.max(0, v));
  }),
  SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE: z.coerce.number().default(0.05).transform((v) => {
    if (!Number.isFinite(v)) return 0.05;
    return Math.min(1, Math.max(0, v));
  }),
  // "lightweight" (default): always-on size + prefix-stability metrics, no payload capture.
  // "full": additionally captures payload preview. "off": disabled.
  SYNESIS_YARN_REQUEST_FORENSICS_MODE: z
    .string()
    .optional()
    .transform((v) => {
      const val = (v ?? "lightweight").toLowerCase();
      if (val === "full" || val === "off") return val;
      return "lightweight" as const;
    }),
  // Legacy compat: explicit true/false overrides mode to full/off when set.
  SYNESIS_YARN_REQUEST_FORENSICS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_REQUEST_FORENSICS_CAPTURE_PAYLOAD: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_REQUEST_FORENSICS_MAX_PREVIEW_CHARS: z.coerce.number().default(4000),

  // Session execution context — project_root / shell_cwd in WORKING_FRAME
  SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // When true, clamp Read/Write/Edit/Update file_path to project_root/shell_cwd anchor across coder routes.
  SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // When true, block risky mkdir/cd duplicate-segment drift by rewriting Bash to a safe error command.
  SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Git-first policy mode for prompts and guarded git MCP tools.
  SYNESIS_YARN_GIT_POLICY_MODE: z
    .enum(["off", "advisory", "enforced"])
    .default("advisory"),

  // Workspace context handshake (synthetic first tool call).
  SYNESIS_YARN_WORKSPACE_CONTEXT_HANDSHAKE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_WORKSPACE_CONTEXT_HANDSHAKE_MAX_ATTEMPTS: z.coerce.number().default(1),

  // Extended memory — structural index, memory tools, hierarchical summaries, chunked eval
  SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_STRUCTURAL_INDEX_TOKEN_BUDGET: z.coerce.number().default(1536),
  SYNESIS_YARN_STRUCTURAL_INDEX_TTL_S: z.coerce.number().default(3600),
  SYNESIS_YARN_MEMORY_TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_MEMORY_STORE_MAX_ENTRIES: z.coerce.number().default(200),
  SYNESIS_YARN_HIERARCHICAL_SUMMARIES_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_SUMMARY_MAX_TOKENS: z.coerce.number().default(100),
  SYNESIS_YARN_CHUNKED_EVAL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_YARN_CHUNKED_EVAL_MAX_FEATURES_PER_PASS: z.coerce.number().default(5),
  SYNESIS_YARN_GO_DOC_REPOMAP_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  /** Terminal interception: ANSI/\\r/repeat shaping for MCP runners and sandbox (default on). */
  SYNESIS_YARN_TERMINAL_SHAPING_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  /** ACP Bash: max wall-clock wait for waitForExit (local editor terminal). */
  SYNESIS_YARN_ACP_BASH_TIMEOUT_MS: z.coerce.number().default(600_000),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
