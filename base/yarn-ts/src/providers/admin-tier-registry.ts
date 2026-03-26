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

export interface TierConfig {
  id: "synesis-pulse" | "synesis-core" | "synesis-horizon";
  backendModel: string;
  baseUrl: string;
  apiKey: string;
}

const ROLE_TO_TIER: Record<string, TierConfig["id"]> = {
  "coder-pulse": "synesis-pulse",
  "coder-core": "synesis-core",
  "coder-horizon": "synesis-horizon"
};

const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai"
};

export async function fetchTierConfigs(config: AppConfig): Promise<TierConfig[]> {
  const hasToken = Boolean(config.SYNESIS_INTERNAL_SERVICE_TOKEN);
  const path = hasToken ? "/api/v1/models/roles/internal" : "/api/v1/models/roles";
  const url = `${config.SYNESIS_YARN_ADMIN_API_URL}${path}`;
  const headers: Record<string, string> = {};
  if (hasToken) {
    const token = config.SYNESIS_INTERNAL_SERVICE_TOKEN!;
    headers["x-synesis-service-token"] = token;
    headers["x-synesis-service-name"] = "synesis-yarn-ts";
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`tier fetch failed ${response.status}`);
  }
  const payload = RolesEnvelopeSchema.parse(await response.json());
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
    out.push({
      id: tierId,
      backendModel: row.model ?? "",
      baseUrl: endpoint,
      apiKey
    });
  }
  return out;
}
