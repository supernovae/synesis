import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  SYNESIS_PLANNER_TS_OTEL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().default("synesis-planner-ts"),
  SYNESIS_PLANNER_TS_MODEL_ID: z.string().default("Synesis Auto"),
  SYNESIS_PLANNER_TS_MODEL_IDS: z.string().default("Synesis Auto,Synesis Pulse,Synesis Core,Synesis Horizon"),
  SYNESIS_PLANNER_TS_LLM_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_PLANNER_TS_LLM_BASE_URL: z.string().default(""),
  SYNESIS_PLANNER_TS_LLM_API_KEY: z.string().default(""),
  SYNESIS_PLANNER_TS_WRITER_MODEL: z.string().default("Synesis"),
  SYNESIS_PLANNER_TS_CRITIC_MODEL: z.string().default("Synesis"),
  SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS: z.coerce.number().default(300000),
  SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MODEL: z.string().default("synesis-general"),
  SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MAX_TOKENS: z.coerce.number().default(350),
  SYNESIS_PLANNER_TS_AMBIGUITY_THRESHOLD: z.coerce.number().default(0.58),
  SYNESIS_PLANNER_TS_LLM_RETRY_MAX_ATTEMPTS: z.coerce.number().default(3),
  SYNESIS_PLANNER_TS_LLM_RETRY_BASE_DELAY_MS: z.coerce.number().default(1000),
  SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().default(5),
  SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS: z.coerce.number().default(60000),
  SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_HALF_OPEN_MAX: z.coerce.number().default(1),
  SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS: z.coerce.number().default(60000),
  SYNESIS_PLANNER_TS_WRITER_NODE_TIMEOUT_MS: z.coerce.number().default(180000),
  SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(30),
  SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT: z.coerce.number().default(50),
  SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX: z.coerce.number().default(100),
  SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS: z.coerce.number().default(30000),
  /** Writer: trivial fast-path policy target (tokens). */
  SYNESIS_PLANNER_TS_TRIVIAL_WRITER_BUDGET: z.coerce.number().default(2048),
  /** Writer: scaled budget at difficulty 0 (tokens). */
  SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE: z.coerce.number().default(2048),
  /** Writer: scaled budget at difficulty 1 before tier clamp (tokens). */
  SYNESIS_PLANNER_TS_WRITER_BUDGET_MAX: z.coerce.number().default(32768),
  /** `audit`: raise writer `max_tokens` to audit floor while recording policy target; `enforced`: target equals API cap. */
  SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE: z.enum(["audit", "enforced"]).default("audit"),
  /** In audit mode, minimum effective writer `max_tokens` (soft floor). */
  SYNESIS_PLANNER_TS_WRITER_BUDGET_AUDIT_FLOOR: z.coerce.number().default(4096),
  /** Hard ceiling on writer `max_tokens` regardless of mode (safety). */
  SYNESIS_PLANNER_TS_WRITER_OUTPUT_SAFETY_CEILING: z.coerce.number().default(32768),
  /** Critic: linear scale base (tokens). */
  SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE: z.coerce.number().default(800),
  /** Critic: linear scale max before global clamp (tokens). */
  SYNESIS_PLANNER_TS_CRITIC_BUDGET_MAX: z.coerce.number().default(4000),
  /** Hard ceiling on critic `max_tokens` (tokens). */
  SYNESIS_PLANNER_TS_CRITIC_MAX_TOKENS: z.coerce.number().default(4096),
  /** LLM planner JSON plan output cap (base; adaptive scaling may raise this). */
  SYNESIS_PLANNER_TS_PLANNER_MAX_TOKENS: z.coerce.number().default(4096),
  SYNESIS_PLANNER_TS_CRITIC_BACKGROUND: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_CRITIC_SKIP_BELOW_DIFFICULTY: z.coerce.number().default(0.15),
  SYNESIS_PLANNER_TS_CRITIC_LENIENT_BELOW_DIFFICULTY: z.coerce.number().default(0.4),
  SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS: z.coerce.number().default(240000),
  SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT: z.coerce.number().default(24),
  SYNESIS_PLANNER_TS_SESSION_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY: z.coerce.number().default(60),
  SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES: z.coerce.number().default(12),
  SYNESIS_PLANNER_TS_SESSION_TTL_MS: z.coerce.number().default(14400000),
  SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS: z.coerce.number().default(5000),
  SYNESIS_PLANNER_TS_REDIS_CAS_MAX_RETRIES: z.coerce.number().default(5),
  SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
  SYNESIS_PLANNER_TS_HEALTH_MONITOR_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_HEALTH_MONITOR_INTERVAL_MS: z.coerce.number().default(15000),
  SYNESIS_PLANNER_TS_HEALTH_MONITOR_TIMEOUT_MS: z.coerce.number().default(2000),
  SYNESIS_OPENFGA_API_URL: z.string().default(""),
  SYNESIS_OPENFGA_STORE_ID: z.string().default(""),
  SYNESIS_OPENFGA_MODEL_ID: z.string().default(""),
  SYNESIS_OPENFGA_AUTH_TOKEN: z.string().default(""),
  SYNESIS_PLANNER_TS_ADMIN_DB_URL: z.string().default(""),
  SYNESIS_PAT_PEPPER: z.string().default(""),
  SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),

  SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE: z
    .enum(["auto", "strict", "disabled"])
    .default("auto"),

  SYNESIS_PLANNER_TS_REDIS_URL: z.string().default(""),
  SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX: z.string().default("synesis:planner:session:"),
  SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S: z.coerce.number().default(14400),

  SYNESIS_ADMIN_URL: z.string().default(""),
  SYNESIS_ADMIN_INTERNAL_TOKEN: z.string().default(""),
  SYNESIS_PLANNER_TS_PROMPT_REFRESH_MS: z.coerce.number().default(30000),
  SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER: z.coerce.number().default(0.1),
  /** Publish knowledge gap when router max_confidence is below this. */
  SYNESIS_PLANNER_TS_KNOWLEDGE_GAP_THRESHOLD: z.coerce.number().default(0.4),
  /** Enable/disable knowledge gap publishing. */
  SYNESIS_PLANNER_TS_KNOWLEDGE_BACKLOG_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // --- Closing follow-up ---
  SYNESIS_PLANNER_TS_CLOSING_FOLLOWUP_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // --- Mermaid guardrails ---
  SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_MERMAID_GUARD_STRICT: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  /** When true, replace JSON-only `{"tags":[...]}`-style writer output with a prose fallback. */
  SYNESIS_PLANNER_TS_WRITER_METADATA_JSON_GUARD: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // --- Injection scanning ---
  SYNESIS_INJECTION_SCAN_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_INJECTION_ACTION: z
    .enum(["reduce", "block", "log"])
    .default("reduce"),
  /** When true, `reduce` / `block` apply only if scanUserInput reports ≥2 pattern hits (fewer false positives for single quoted phrases). Default preserves legacy behavior. */
  SYNESIS_INJECTION_REQUIRE_DUAL_SIGNAL: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),

  // --- Frame extraction ---
  SYNESIS_GLINER_SERVICE_URL: z.string().default(""),

  // --- Retrieval / RAG ---
  SYNESIS_MILVUS_HOST: z.string().default("synesis-milvus.synesis-rag.svc.cluster.local"),
  SYNESIS_MILVUS_PORT: z.coerce.number().default(19530),
  SYNESIS_EMBEDDER_URL: z.string().default(""),
  SYNESIS_EMBEDDER_MODEL: z.string().default("sentence-transformers/all-MiniLM-L6-v2"),
  SYNESIS_BGE_RERANKER_URL: z.string().default(""),
  SYNESIS_RAG_TOP_K: z.coerce.number().default(5),
  SYNESIS_RAG_RETRIEVAL_STRATEGY: z
    .enum(["hybrid", "vector", "bm25"])
    .default("hybrid"),
  SYNESIS_RAG_RRF_K: z.coerce.number().default(60),
  SYNESIS_RAG_SCORE_THRESHOLD: z.coerce.number().default(0.25),
  SYNESIS_RAG_RERANK_SCORE_MIN: z.coerce.number().default(0.05),
  SYNESIS_RAG_OVERFETCH_MIN: z.coerce.number().default(30),
  SYNESIS_RAG_OVERFETCH_MAX: z.coerce.number().default(50),
  SYNESIS_RAG_ADAPTIVE_GAP_MULTIPLIER: z.coerce.number().default(1.5),

  // --- Web search ---
  SYNESIS_WEB_SEARCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_WEB_SEARCH_URL: z.string().default("http://searxng.synesis-search.svc.cluster.local:8080"),
  SYNESIS_WEB_SEARCH_TIMEOUT_MS: z.coerce.number().default(5000),
  SYNESIS_WEB_SEARCH_MAX_RESULTS: z.coerce.number().default(5),
  SYNESIS_ENGINE_AUTHORITY_MAP: z.string().default("{}"),
  SYNESIS_DOMAIN_POLICY_MODE: z.enum(["prefer", "restrict"]).default("prefer"),
  SYNESIS_DOMAIN_POLICY_BOOST: z.coerce.number().default(1.4),
  SYNESIS_WEB_BUDGET_BASE: z.coerce.number().default(1),
  SYNESIS_WEB_BUDGET_MAX: z.coerce.number().default(8),

  // --- Freshness ---
  SYNESIS_FRESHNESS_WEIGHT: z.coerce.number().default(0.1),

  // --- Cohesion ---
  SYNESIS_COHESION_LOCK_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_COHESION_LOCK_MIN_RESULTS: z.coerce.number().default(3),
  SYNESIS_COHESION_EMBEDDING_THRESHOLD: z.coerce.number().default(0.15),
  SYNESIS_COHESION_LLM_BORDERLINE_LOW: z.coerce.number().default(0.15),
  SYNESIS_COHESION_LLM_BORDERLINE_HIGH: z.coerce.number().default(0.30),
  SYNESIS_COHESION_COMPRESSION_THRESHOLD: z.coerce.number().default(0.20),

  // --- Taxonomy / Ontology ---
  SYNESIS_ENTRY_CLASSIFIER_WEIGHTS: z.string().default(""),
  SYNESIS_PLANNER_TS_PLUGIN_WEIGHTS_DIR: z.string().default(""),
  SYNESIS_ENTRY_CLASSIFIER_PLUGINS: z.string().default(""),
  SYNESIS_TAXONOMY_PROMPT_CONFIG: z.string().default(""),
  SYNESIS_TAXONOMY_CACHE_TTL: z.coerce.number().default(300),
  SYNESIS_ONTOLOGY_REFRESH_S: z.coerce.number().default(300),
  SYNESIS_MODEL_CAPABILITY_TIER: z.string().default("small"),
  SYNESIS_ONTOLOGY_SERVICE_URL: z.string().default(""),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
