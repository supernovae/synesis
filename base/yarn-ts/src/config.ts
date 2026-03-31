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
  SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: z.coerce.number().default(12_000),
  SYNESIS_YARN_VALIDATION_MAX_FINDINGS: z.coerce.number().default(30),
  SYNESIS_YARN_VALIDATION_INCLUDE_RAW: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
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
  SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS: z.coerce.number().default(2_000_000),
  SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT: z.coerce.number().default(15),
  SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT: z.coerce.number().default(10),
  SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT: z.coerce.number().default(4),
  SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT: z.coerce.number().default(2),
  SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Per-user rate limiting (sliding window)
  SYNESIS_YARN_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  SYNESIS_YARN_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(30),

  // Circuit breaker for model providers
  SYNESIS_YARN_BREAKER_FAILURE_THRESHOLD: z.coerce.number().default(5),
  SYNESIS_YARN_BREAKER_RECOVERY_TIMEOUT_MS: z.coerce.number().default(60_000),
  SYNESIS_YARN_BREAKER_HALF_OPEN_MAX: z.coerce.number().default(1),

  // Diagnostics ring buffer
  SYNESIS_YARN_DIAGNOSTIC_RING_MAX: z.coerce.number().default(100),

  // Artifact store bounds (memory safety when feature is enabled)
  SYNESIS_YARN_ARTIFACT_MAX_COUNT: z.coerce.number().default(500),
  SYNESIS_YARN_ARTIFACT_TTL_MS: z.coerce.number().default(3_600_000),
  SYNESIS_YARN_ARTIFACT_MAX_PAYLOAD_BYTES: z.coerce.number().default(1_048_576),

  // Policy engine repeat-map bounds (memory safety)
  SYNESIS_YARN_POLICY_REPEAT_MAP_MAX: z.coerce.number().default(5000),
  SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS: z.coerce.number().default(1_800_000),

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
  SYNESIS_YARN_MCP_SERVICE_URL: z.string().default(
    "http://synesis-mcp-ts.synesis-yarn.svc.cluster.local:8100",
  ),
  SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: z
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
  SYNESIS_YARN_JITTER_BUFFER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_SORTED_TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

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

  // Reliability hardening (Phase 11)
  SYNESIS_YARN_AUTH_POOL_MAX: z.coerce.number().default(5),
  SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS: z.coerce.number().default(30_000),
  SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS: z.coerce.number().default(2000),
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
  SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD: z.coerce.number().default(0.5),

  // Debug / trace
  SYNESIS_YARN_DEBUG_PROTOCOL: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true")
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
