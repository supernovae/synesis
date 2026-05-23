import { z } from "zod";

const ConfigSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8102),
  LOG_LEVEL: z.string().default("info"),
  /** Admin FastAPI base URL (same cluster — internal tools + auth). */
  SYNESIS_ADMIN_API_URL: z.string().default("http://synesis-admin.synesis-admin.svc.cluster.local:8080"),
  /** Planner base URL for developer value-add tools such as knowledge search. */
  SYNESIS_PLANNER_URL: z.string().default("http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080"),
  /** Optional planner-specific internal token; falls back to SYNESIS_INTERNAL_SERVICE_TOKEN. */
  SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
  /** Streamable HTTP path for MCP (match synesis-mcp pattern). */
  SYNESIS_ADMIN_MCP_HTTP_PATH: z.string().default("/mcp"),
  SYNESIS_ADMIN_MCP_GLOBAL_RATE_LIMIT_MAX: z.coerce.number().default(1200),
  SYNESIS_ADMIN_MCP_GLOBAL_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  SYNESIS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
  SYNESIS_ADMIN_MCP_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SYNESIS_ADMIN_MCP_WATCH_MAX_MS: z.coerce.number().int().positive().default(30000),
  SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: z.coerce.number().int().positive().default(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type AdminMcpConfig = z.infer<typeof ConfigSchema>;

export function adminApiBaseUrl(cfg: Pick<AdminMcpConfig, "SYNESIS_ADMIN_API_URL">): string {
  return cfg.SYNESIS_ADMIN_API_URL.trim().replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
}

export function loadConfig(): AdminMcpConfig {
  return ConfigSchema.parse(process.env);
}
