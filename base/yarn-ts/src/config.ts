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
  SYNESIS_YARN_ADMIN_DB_URL: z.string().default(""),
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
  SYNESIS_YARN_PERSIST_USAGE_TO_DB: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

  // Safety limits
  SYNESIS_YARN_POLICY_HARD_REJECT_AFTER: z.coerce.number().default(6),
  SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS: z.coerce.number().default(500_000),
  SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT: z.coerce.number().default(15),
  SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT: z.coerce.number().default(10),

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
  SYNESIS_YARN_SESSION_CONTINUITY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),

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
