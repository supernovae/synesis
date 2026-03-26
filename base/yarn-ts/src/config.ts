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
  SYNESIS_YARN_DB_POOL_MAX: z.coerce.number().default(20),
  SYNESIS_YARN_DB_POOL_IDLE_MS: z.coerce.number().default(30000),
  SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: z.coerce.number().default(3000),
  SYNESIS_YARN_WRITE_QUEUE_MAX: z.coerce.number().default(10000),
  SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: z.coerce.number().default(50),
  SYNESIS_YARN_PERSIST_USAGE_TO_DB: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false")
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
