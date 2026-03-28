import { z } from "zod";
import type { AppConfig } from "../config.js";

const RoleSchema = z.object({
  role: z.string(),
  assigned: z.boolean().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  provider: z.string().optional(),
  api_key_env: z.string().optional(),
  litellm_params: z.record(z.string(), z.any()).optional()
});

const RolesEnvelopeSchema = z.object({
  roles: z.array(RoleSchema)
});

const CostRowSchema = z.object({
  role: z.string(),
  input_per_million: z.number().optional(),
  output_per_million: z.number().optional(),
  input_cached_per_million: z.number().nullable().optional()
});

const CostEnvelopeSchema = z
  .object({
    costs: z.array(CostRowSchema).optional(),
    roles: z.array(CostRowSchema).optional()
  })
  .passthrough();

export type TierId = "synesis-pulse" | "synesis-core" | "synesis-horizon" | "synesis-compaction";

export interface TierConfig {
  id: TierId;
  backendModel: string;
  baseUrl: string;
  apiKey: string;
  inputPerM: number;
  outputPerM: number;
  cachedPerM: number | null;
}

const ROLE_TO_TIER: Record<string, TierId> = {
  "coder-pulse": "synesis-pulse",
  "coder-core": "synesis-core",
  "coder-horizon": "synesis-horizon",
  "coder-compaction": "synesis-compaction"
};

const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "dashscope-us": "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
};

export async function fetchTierConfigs(config: AppConfig): Promise<TierConfig[]> {
  const hasToken = Boolean(config.SYNESIS_INTERNAL_SERVICE_TOKEN);
  const rolesPath = hasToken ? "/api/v1/models/roles/internal" : "/api/v1/models/roles";
  const costsPath = hasToken ? "/api/v1/models/costs/active/internal" : "/api/v1/models/costs/active";
  const rolesUrl = `${config.SYNESIS_YARN_ADMIN_API_URL}${rolesPath}`;
  const costsUrl = `${config.SYNESIS_YARN_ADMIN_API_URL}${costsPath}`;
  const headers: Record<string, string> = {};
  if (hasToken) {
    const token = config.SYNESIS_INTERNAL_SERVICE_TOKEN!;
    headers["x-synesis-service-token"] = token;
    headers["x-synesis-service-name"] = "synesis-yarn-ts";
    headers.authorization = `Bearer ${token}`;
  }
  const [rolesResponse, costsResponse] = await Promise.all([fetch(rolesUrl, { headers }), fetch(costsUrl, { headers })]);
  if (!rolesResponse.ok) {
    throw new Error(`tier role fetch failed ${rolesResponse.status}`);
  }
  if (!costsResponse.ok) {
    throw new Error(`tier costs fetch failed ${costsResponse.status}`);
  }
  const payload = RolesEnvelopeSchema.parse(await rolesResponse.json());
  const costPayload = CostEnvelopeSchema.parse(await costsResponse.json());
  const costs = costPayload.costs ?? costPayload.roles ?? [];
  const costByRole = new Map<string, z.infer<typeof CostRowSchema>>();
  for (const row of costs) {
    costByRole.set(row.role, row);
  }
  const out: TierConfig[] = [];
  for (const row of payload.roles) {
    const tierId = ROLE_TO_TIER[row.role];
    if (!tierId || !row.assigned) {
      continue;
    }
    const provider = (row.provider ?? "").toLowerCase();
    const lp = row.litellm_params ?? {};
    const endpoint = (row.endpoint ?? "").trim() || String(lp.api_base ?? "").trim() || PROVIDER_BASE_URLS[provider] || config.SYNESIS_YARN_OPENAI_COMPAT_BASE_URL;
    const keyEnv = (row.api_key_env ?? "").trim();
    const apiKey = (keyEnv ? process.env[keyEnv] : undefined) || config.SYNESIS_YARN_OPENAI_COMPAT_API_KEY;
    const cost = costByRole.get(row.role);
    out.push({
      id: tierId,
      backendModel: row.model ?? "",
      baseUrl: endpoint,
      apiKey,
      inputPerM: Number(cost?.input_per_million ?? 0),
      outputPerM: Number(cost?.output_per_million ?? 0),
      cachedPerM:
        cost?.input_cached_per_million == null
          ? null
          : Number(cost.input_cached_per_million)
    });
  }
  return out;
}
