import { z } from "zod";
import {
  FALLBACK_BASE_RATES,
  hasNonZeroRates,
  type PricingRates,
  type PricingSource,
} from "@synesis/telemetry";
import type { AppConfig } from "../config.js";

const RoleSchema = z.object({
  role: z.string(),
  assigned: z.boolean().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  provider: z.string().optional(),
  api_key_env: z.string().optional(),
  litellm_params: z.record(z.string(), z.any()).nullable().optional(),
  adapter_hint: z.string().nullable().optional(),
});

const RolesEnvelopeSchema = z.object({
  roles: z.array(RoleSchema)
});

const PromptProfileSchema = z.object({
  id: z.number(),
  name: z.string(),
  service: z.string(),
  content: z.string(),
  content_hash: z.string(),
});

const PromptAssignmentSchema = z.object({
  id: z.number(),
  service: z.string(),
  target_type: z.string(),
  target_value: z.string(),
  profile_id: z.number(),
});

const PromptSnapshotSchema = z.object({
  service: z.string(),
  profiles: z.array(PromptProfileSchema),
  assignments: z.array(PromptAssignmentSchema),
  updated_at: z.string().nullable().optional(),
});

const CostRowSchema = z.object({
  role: z.string(),
  input_per_million: z.number().optional(),
  output_per_million: z.number().optional(),
  input_cached_per_million: z.number().nullable().optional(),
  pricing_source: z.string().optional(),
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
  pricingSource: PricingSource;
  adapterHint?: string | null;
}

export interface RoleAssignmentConfig {
  role: string;
  assigned: boolean;
  backendModel: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  adapterHint?: string | null;
}

export interface TierRegistrySnapshot {
  tiers: TierConfig[];
  roleAssignments: RoleAssignmentConfig[];
  promptSnapshot?: PromptSnapshot;
}

export type PromptProfile = z.infer<typeof PromptProfileSchema>;
export type PromptAssignment = z.infer<typeof PromptAssignmentSchema>;
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>;

export const ROLE_TO_TIER: Record<string, TierId> = {
  "coder-pulse": "synesis-pulse",
  "coder-core": "synesis-core",
  "coder-horizon": "synesis-horizon",
  "coder-compaction": "synesis-compaction"
};

export const TIER_TO_ROLE: Record<TierId, string> = {
  "synesis-pulse": "coder-pulse",
  "synesis-core": "coder-core",
  "synesis-horizon": "coder-horizon",
  "synesis-compaction": "coder-compaction",
};

const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "dashscope-us": "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
};

export function resolveTierRates(
  registryRates: PricingRates | undefined,
  registrySource: PricingSource | undefined,
): { rates: PricingRates; pricingSource: PricingSource } {
  if (registryRates && hasNonZeroRates(registryRates)) {
    return { rates: registryRates, pricingSource: registrySource ?? "manual" };
  }
  return { rates: { ...FALLBACK_BASE_RATES }, pricingSource: "fallback_base" };
}

export async function fetchTierRegistrySnapshot(config: AppConfig): Promise<TierRegistrySnapshot> {
  const hasToken = Boolean(config.SYNESIS_INTERNAL_SERVICE_TOKEN);
  const rolesPath = hasToken ? "/api/v1/models/roles/internal" : "/api/v1/models/roles";
  const costsPath = hasToken ? "/api/v1/models/costs/active/internal" : "/api/v1/models/costs/active";
  const promptsPath = "/api/v1/models/prompts/internal/yarn";
  const rolesUrl = `${config.SYNESIS_YARN_ADMIN_API_URL}${rolesPath}`;
  const costsUrl = `${config.SYNESIS_YARN_ADMIN_API_URL}${costsPath}`;
  const promptsUrl = `${config.SYNESIS_YARN_ADMIN_API_URL}${promptsPath}`;
  const headers: Record<string, string> = {};
  if (hasToken) {
    const token = config.SYNESIS_INTERNAL_SERVICE_TOKEN!;
    headers["x-synesis-service-token"] = token;
    headers["x-synesis-service-name"] = "synesis-yarn-ts";
    headers.authorization = `Bearer ${token}`;
  }
  const [rolesResponse, costsResponse, promptsResponse] = await Promise.all([
    fetch(rolesUrl, { headers }),
    fetch(costsUrl, { headers }),
    hasToken ? fetch(promptsUrl, { headers }) : Promise.resolve(null),
  ]);
  if (!rolesResponse.ok) {
    throw new Error(`tier role fetch failed ${rolesResponse.status}`);
  }
  if (!costsResponse.ok) {
    throw new Error(`tier costs fetch failed ${costsResponse.status}`);
  }
  const payload = RolesEnvelopeSchema.parse(await rolesResponse.json());
  const costPayload = CostEnvelopeSchema.parse(await costsResponse.json());
  let promptSnapshot: PromptSnapshot | undefined;
  if (promptsResponse && promptsResponse.ok) {
    try {
      promptSnapshot = PromptSnapshotSchema.parse(await promptsResponse.json());
    } catch {
      promptSnapshot = undefined;
    }
  }
  const costs = costPayload.costs ?? costPayload.roles ?? [];
  const costByRole = new Map<string, z.infer<typeof CostRowSchema>>();
  for (const row of costs) {
    costByRole.set(row.role, row);
  }
  const out: TierConfig[] = [];
  const roleAssignments: RoleAssignmentConfig[] = [];
  for (const row of payload.roles) {
    if (!row.assigned) {
      continue;
    }
    const provider = (row.provider ?? "").toLowerCase();
    const lp = row.litellm_params ?? {};
    const endpoint = (row.endpoint ?? "").trim() || String(lp.api_base ?? "").trim() || PROVIDER_BASE_URLS[provider] || config.SYNESIS_YARN_OPENAI_COMPAT_BASE_URL;
    const keyEnv = (row.api_key_env ?? "").trim();
    const apiKey = (keyEnv ? process.env[keyEnv] : undefined) || config.SYNESIS_YARN_OPENAI_COMPAT_API_KEY;
    roleAssignments.push({
      role: row.role,
      assigned: true,
      backendModel: row.model ?? "",
      baseUrl: endpoint,
      apiKey,
      provider,
      adapterHint: row.adapter_hint ?? null,
    });
    const tierId = ROLE_TO_TIER[row.role];
    if (!tierId) {
      continue;
    }
    const cost = costByRole.get(row.role);
    const registryRates: PricingRates = {
      input_per_million: Number(cost?.input_per_million ?? 0),
      output_per_million: Number(cost?.output_per_million ?? 0),
      cached_input_per_million:
        cost?.input_cached_per_million == null
          ? null
          : Number(cost.input_cached_per_million),
    };
    const { rates, pricingSource } = resolveTierRates(
      registryRates,
      cost?.pricing_source as PricingSource | undefined,
    );
    out.push({
      id: tierId,
      backendModel: row.model ?? "",
      baseUrl: endpoint,
      apiKey,
      inputPerM: rates.input_per_million,
      outputPerM: rates.output_per_million,
      cachedPerM: rates.cached_input_per_million,
      pricingSource,
      adapterHint: row.adapter_hint ?? null,
    });
  }
  return { tiers: out, roleAssignments, promptSnapshot };
}

export async function fetchTierConfigs(config: AppConfig): Promise<TierConfig[]> {
  const snapshot = await fetchTierRegistrySnapshot(config);
  return snapshot.tiers;
}
