import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
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
  SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS: z.coerce.number().default(15000),
  SYNESIS_PLANNER_TS_CRITIC_BACKGROUND: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_CRITIC_SKIP_BELOW_DIFFICULTY: z.coerce.number().default(0.15),
  SYNESIS_PLANNER_TS_CRITIC_LENIENT_BELOW_DIFFICULTY: z.coerce.number().default(0.4),
  SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS: z.coerce.number().default(12000),
  SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT: z.coerce.number().default(24),
  SYNESIS_PLANNER_TS_SESSION_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY: z.coerce.number().default(60),
  SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES: z.coerce.number().default(12),
  SYNESIS_PLANNER_TS_SESSION_TTL_MS: z.coerce.number().default(14400000),
  SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
  SYNESIS_PLANNER_TS_AUTHZ_ENGINE: z
    .enum(["deterministic", "openfga_stub"])
    .default("deterministic"),
  SYNESIS_PLANNER_TS_OPENFGA_API_URL: z.string().default(""),
  SYNESIS_PLANNER_TS_OPENFGA_STORE_ID: z.string().default(""),
  SYNESIS_PLANNER_TS_OPENFGA_MODEL_ID: z.string().default(""),
  SYNESIS_PLANNER_TS_OPENFGA_AUTH_TOKEN: z.string().default(""),

  SYNESIS_OPENFGA_API_URL: z.string().default(""),
  SYNESIS_OPENFGA_STORE_ID: z.string().default(""),
  SYNESIS_OPENFGA_MODEL_ID: z.string().default(""),
  SYNESIS_OPENFGA_AUTH_TOKEN: z.string().default(""),
  SYNESIS_AUTHZ_ENGINE: z.enum(["deterministic", "openfga_shadow", "openfga_enforce"]).default("deterministic"),
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
  SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER: z.coerce.number().default(0.1)
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
