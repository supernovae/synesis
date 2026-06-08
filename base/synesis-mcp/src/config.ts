import { z } from "zod";
import { validatePatPepperRequirement } from "@synesis/auth-contracts";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8100),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  /** Streamable HTTP MCP endpoint path */
  SYNESIS_MCP_HTTP_PATH: z.string().regex(/^\//).default("/mcp"),
  SYNESIS_MCP_GLOBAL_RATE_LIMIT_MAX: z.coerce.number().default(1200),
  SYNESIS_MCP_GLOBAL_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  SYNESIS_PLANNER_URL: z.string().url().default(
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
  ),
  SYNESIS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
  /** PAT validation (same DB as Yarn admin) */
  SYNESIS_ADMIN_DB_URL: z.string().optional(),
  SYNESIS_PAT_PEPPER: z.string().default(""),
  SYNESIS_OIDC_ISSUER_URL: z.string().default(""),
  SYNESIS_OIDC_INTERNAL_ISSUER_URL: z.string().default(""),
  SYNESIS_OIDC_ALLOWED_CLIENT_IDS: z.string().default("synesis-harness"),
  SYNESIS_OIDC_REQUIRED_ROLES: z.string().default("synesis-user,synesis-org-admin,synesis-admin"),
  SYNESIS_OIDC_JWKS_CACHE_TTL_MS: z.coerce.number().default(300_000),
  SYNESIS_REQUIRE_PAT_PEPPER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SYNESIS_DB_POOL_MAX: z.coerce.number().default(4),
  SYNESIS_DB_POOL_IDLE_MS: z.coerce.number().default(10_000),
  SYNESIS_DB_POOL_CONN_TIMEOUT_MS: z.coerce.number().default(5_000),
  /** OpenFGA — same env as Yarn; reuse yarn_endpoint:completions for policy parity */
  SYNESIS_OPENFGA_API_URL: z.string().optional(),
  SYNESIS_OPENFGA_STORE_ID: z.string().optional(),
  SYNESIS_OPENFGA_AUTH_TOKEN: z.string().optional(),
  SYNESIS_OPENFGA_MODEL_ID: z.string().optional(),
  SYNESIS_MCP_AUTHZ_MODE: z.enum(["audit", "enforce"]).default("enforce"),
  /** When true, allow requests with only internal service token (no PAT) — cluster internal */
  SYNESIS_MCP_ALLOW_INTERNAL_ONLY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Comma-separated exact CORS origins. "*" is development-only and must be non-credentialed. */
  SYNESIS_MCP_CORS_ORIGINS: z.string().default(""),
  SYNESIS_MCP_CORS_ALLOW_CREDENTIALS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  OTEL_SERVICE_NAME: z.string().default("synesis-mcp"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type McpTsConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpTsConfig {
  const config = EnvSchema.parse(env);
  validatePatPepperRequirement({
    patValidationEnabled: Boolean(config.SYNESIS_ADMIN_DB_URL?.trim()),
    pepper: config.SYNESIS_PAT_PEPPER,
    requirePatPepper: config.SYNESIS_REQUIRE_PAT_PEPPER,
    serviceName: "synesis-mcp",
  });
  const corsOrigins = config.SYNESIS_MCP_CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (corsOrigins.includes("*")) {
    if (corsOrigins.length > 1) {
      throw new Error("SYNESIS_MCP_CORS_ORIGINS='*' must not be combined with exact origins");
    }
    if (config.SYNESIS_MCP_CORS_ALLOW_CREDENTIALS) {
      throw new Error("SYNESIS_MCP_CORS_ORIGINS='*' requires SYNESIS_MCP_CORS_ALLOW_CREDENTIALS=false");
    }
    if (config.NODE_ENV !== "development") {
      throw new Error("SYNESIS_MCP_CORS_ORIGINS='*' is not allowed outside development");
    }
  }
  return config;
}
