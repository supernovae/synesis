import { z } from "zod";

const ConfigSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8102),
  LOG_LEVEL: z.string().default("info"),
  /** Admin FastAPI base URL (same cluster — internal tools + auth). */
  SYNESIS_ADMIN_API_URL: z.string().default("http://synesis-admin.synesis-admin.svc.cluster.local:8080"),
  /** Streamable HTTP path for MCP (match synesis-mcp-ts pattern). */
  SYNESIS_ADMIN_MCP_HTTP_PATH: z.string().default("/mcp"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type AdminMcpConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AdminMcpConfig {
  return ConfigSchema.parse(process.env);
}
