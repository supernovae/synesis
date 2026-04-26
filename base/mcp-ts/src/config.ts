import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8100),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  /** Streamable HTTP MCP endpoint path */
  SYNESIS_MCP_HTTP_PATH: z.string().default("/mcp"),
  SYNESIS_MCP_GLOBAL_RATE_LIMIT_MAX: z.coerce.number().default(1200),
  SYNESIS_MCP_GLOBAL_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  SYNESIS_PLANNER_URL: z.string().default(
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
  ),
  SYNESIS_CRITIC_URL: z.string().default(
    "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1",
  ),
  SYNESIS_CRITIC_MODEL: z.string().default("synesis-critic"),
  SYNESIS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
  /** PAT validation (same DB as Yarn admin) */
  SYNESIS_ADMIN_DB_URL: z.string().optional(),
  SYNESIS_PAT_PEPPER: z.string().default(""),
  SYNESIS_DB_POOL_MAX: z.coerce.number().default(4),
  SYNESIS_DB_POOL_IDLE_MS: z.coerce.number().default(10_000),
  SYNESIS_DB_POOL_CONN_TIMEOUT_MS: z.coerce.number().default(5_000),
  /** OpenFGA — same env as Yarn; reuse yarn_endpoint:completions for policy parity */
  SYNESIS_OPENFGA_API_URL: z.string().optional(),
  SYNESIS_OPENFGA_STORE_ID: z.string().optional(),
  SYNESIS_OPENFGA_AUTH_TOKEN: z.string().optional(),
  SYNESIS_OPENFGA_MODEL_ID: z.string().optional(),
  /** When true, allow requests with only internal service token (no PAT) — cluster internal */
  SYNESIS_MCP_ALLOW_INTERNAL_ONLY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OTEL_SERVICE_NAME: z.string().default("synesis-mcp-ts"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type McpTsConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpTsConfig {
  return EnvSchema.parse(env);
}
