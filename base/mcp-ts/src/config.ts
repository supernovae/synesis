import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8100),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  SYNESIS_PLANNER_URL: z.string().default(
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
  ),
  SYNESIS_CRITIC_URL: z.string().default(
    "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1",
  ),
  SYNESIS_CRITIC_MODEL: z.string().default("synesis-critic"),
  SYNESIS_INTERNAL_SERVICE_TOKEN: z.string().default(""),
});

export type McpConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return EnvSchema.parse(env);
}
