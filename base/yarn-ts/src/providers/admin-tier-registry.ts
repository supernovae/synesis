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
  context_window: z.number().nullable().optional(),
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
  /** When set, estimated cost includes cache write tokens at this $/1M; else cache_creation billed at input rate. */
  input_cache_write_per_million: z.number().nullable().optional(),
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
  /** Canonical synesis-* tier id or a dynamic public-offering client id. */
  id: string;
  backendModel: string;
  baseUrl: string;
  apiKey: string;
  inputPerM: number;
  outputPerM: number;
  cachedPerM: number | null;
  /** Optional USD per 1M cache-creation (write) tokens for cost estimates. */
  cacheWritePerM: number | null;
  pricingSource: PricingSource;
  adapterHint?: string | null;
  samplingDefaults?: ModelSamplingDefaults;
  /** Optional per-tier context ceiling for budget manager (overrides global config). */
  contextCeilingTokens?: number | null;
}

export interface RoleAssignmentConfig {
  role: string;
  assigned: boolean;
  backendModel: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  adapterHint?: string | null;
  samplingDefaults?: ModelSamplingDefaults;
}

export interface TierRegistrySnapshot {
  tiers: TierConfig[];
  roleAssignments: RoleAssignmentConfig[];
  promptSnapshot?: PromptSnapshot;
}

export interface ModelSamplingDefaults {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  enable_thinking?: boolean;
  reasoning_effort?: string;
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

const EFFORT_TO_TIER: Record<string, TierId> = {
  pulse: "synesis-pulse",
  core: "synesis-core",
  horizon: "synesis-horizon",
};

export const TIER_TO_ROLE: Record<TierId, string> = {
  "synesis-pulse": "coder-pulse",
  "synesis-core": "coder-core",
  "synesis-horizon": "coder-horizon",
  "synesis-compaction": "coder-compaction",
};

/** Canonical tier ids registered in the admin model registry / Yarn tier map. */
export const CANONICAL_SYNESIS_TIER_IDS: readonly TierId[] = [
  "synesis-pulse",
  "synesis-core",
  "synesis-horizon",
  "synesis-compaction",
];

const CANONICAL_SYNESIS_TIER_ID_SET = new Set<string>(CANONICAL_SYNESIS_TIER_IDS);

/**
 * Short names and role-style ids accepted on OpenAI-compatible `model` (and listed on `/v1/models`).
 * Maps to registry tier ids: `pulse` ↔ `synesis-pulse`, etc.
 */
export const OPENAI_COMPAT_TIER_ALIASES: Record<string, TierId> = {
  pulse: "synesis-pulse",
  core: "synesis-core",
  horizon: "synesis-horizon",
  compaction: "synesis-compaction",
  ...ROLE_TO_TIER,
};

/**
 * Normalize client `model` strings so short tier names and path suffixes resolve to registry tier ids.
 * Examples: `core` → `synesis-core`, `OpenAI/core` → `synesis-core`, `synesis-horizon` unchanged.
 * Unknown vendor strings are returned as-is.
 */
export function normalizeOpenAICompatTierModelId(modelId: string): string {
  const raw = (modelId ?? "").trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  if (CANONICAL_SYNESIS_TIER_ID_SET.has(lower)) return lower;
  const mapped = OPENAI_COMPAT_TIER_ALIASES[lower];
  if (mapped) return mapped;
  if (lower.includes("/")) {
    const seg = lower.split("/").pop() ?? lower;
    if (seg !== lower) {
      if (CANONICAL_SYNESIS_TIER_ID_SET.has(seg)) return seg;
      const segMapped = OPENAI_COMPAT_TIER_ALIASES[seg];
      if (segMapped) return segMapped;
    }
  }
  return raw;
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "dashscope-us": "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
};

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseSamplingDefaults(lp: Record<string, unknown>): ModelSamplingDefaults | undefined {
  const out: ModelSamplingDefaults = {};
  const temperature = asFiniteNumber(lp.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = asFiniteNumber(lp.top_p);
  if (topP !== undefined) out.top_p = topP;
  const topK = asFiniteNumber(lp.top_k);
  if (topK !== undefined) out.top_k = topK;
  const minP = asFiniteNumber(lp.min_p);
  if (minP !== undefined) out.min_p = minP;
  const presencePenalty = asFiniteNumber(lp.presence_penalty);
  if (presencePenalty !== undefined) out.presence_penalty = presencePenalty;
  const repetitionPenalty = asFiniteNumber(lp.repetition_penalty);
  if (repetitionPenalty !== undefined) out.repetition_penalty = repetitionPenalty;
  const enableThinking = asBoolean(lp.enable_thinking);
  if (enableThinking !== undefined) out.enable_thinking = enableThinking;
  const reasoningEffort = typeof lp.reasoning_effort === "string" ? lp.reasoning_effort.trim() : "";
  if (reasoningEffort) out.reasoning_effort = reasoningEffort;
  return Object.keys(out).length > 0 ? out : undefined;
}

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
    const lp = (row.litellm_params ?? {}) as Record<string, unknown>;
    const samplingDefaults = parseSamplingDefaults(lp);
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
      samplingDefaults,
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
      cache_write_input_per_million:
        cost?.input_cache_write_per_million == null
          ? null
          : Number(cost.input_cache_write_per_million),
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
      cacheWritePerM: rates.cache_write_input_per_million ?? null,
      pricingSource,
      adapterHint: row.adapter_hint ?? null,
      samplingDefaults,
      contextCeilingTokens: row.context_window ?? null,
    });
  }
  return { tiers: out, roleAssignments, promptSnapshot };
}

export async function fetchTierConfigs(config: AppConfig): Promise<TierConfig[]> {
  const snapshot = await fetchTierRegistrySnapshot(config);
  return snapshot.tiers;
}

const PublicOfferingRowSchema = z.object({
  client_model_id: z.string(),
  effort_tier: z.string().optional(),
  connection_mode: z.string().optional(),
  route_via_role: z.string().nullable().optional(),
  standalone_provider: z.string().nullable().optional(),
  standalone_endpoint: z.string().nullable().optional(),
  standalone_api_key_env: z.string().nullable().optional(),
  backend_model_override: z.string().nullable().optional(),
  generation_params: z.record(z.string(), z.any()).nullable().optional(),
});

export type PublicYarnOffering = z.infer<typeof PublicOfferingRowSchema>;

function normalizeOfferingConnectionMode(mode: string | null | undefined): "role_clone" | "standalone" {
  return (mode ?? "").trim().toLowerCase() === "standalone" ? "standalone" : "role_clone";
}

/**
 * Resolve canonical effort tier id for a public offering.
 */
export function resolveOfferingTierId(offering: PublicYarnOffering): TierId | undefined {
  const mode = normalizeOfferingConnectionMode(offering.connection_mode);
  if (mode === "standalone") {
    const effort = (offering.effort_tier ?? "").trim().toLowerCase();
    return EFFORT_TO_TIER[effort] ?? ROLE_TO_TIER[(offering.route_via_role ?? "").trim().toLowerCase()];
  }
  const role =
    (offering.route_via_role ?? "").trim().toLowerCase()
    || `coder-${(offering.effort_tier ?? "").trim().toLowerCase()}`;
  return ROLE_TO_TIER[role];
}

const PublicOfferingsEnvelopeSchema = z.object({
  offerings: z.array(PublicOfferingRowSchema),
});

/**
 * Active public offerings exposed to Yarn (requires internal service token + admin URL).
 */
export async function fetchPublicOfferingsForYarn(config: AppConfig): Promise<PublicYarnOffering[]> {
  if (!config.SYNESIS_INTERNAL_SERVICE_TOKEN?.trim()) {
    return [];
  }
  const base = config.SYNESIS_YARN_ADMIN_API_URL.replace(/\/$/, "");
  const url = `${base}/api/v1/models/public-offerings/internal?for=yarn`;
  const token = config.SYNESIS_INTERNAL_SERVICE_TOKEN!;
  const headers: Record<string, string> = {
    "x-synesis-service-token": token,
    "x-synesis-service-name": "synesis-yarn-ts",
    authorization: `Bearer ${token}`,
  };
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) {
    return [];
  }
  try {
    const parsed = PublicOfferingsEnvelopeSchema.parse(await resp.json());
    return parsed.offerings;
  } catch {
    return [];
  }
}

/**
 * Clone coder-{effort} tier rows under each public offering client_model_id for OpenAI `model` resolution.
 */
export function mergeYarnPublicOfferingsIntoTiers(
  baseTiers: TierConfig[],
  offerings: PublicYarnOffering[],
): TierConfig[] {
  const byId = new Map(baseTiers.map((t) => [t.id, t]));
  const extra: TierConfig[] = [];
  for (const o of offerings) {
    const canon = resolveOfferingTierId(o);
    if (!canon) continue;
    const base = byId.get(canon);
    if (!base) continue;
    const cid = (o.client_model_id ?? "").trim().toLowerCase();
    if (!cid) continue;
    const override = (o.backend_model_override ?? "").trim();
    const mode = normalizeOfferingConnectionMode(o.connection_mode);
    if (mode === "standalone") {
      const provider = (o.standalone_provider ?? "").trim().toLowerCase();
      const endpoint = (o.standalone_endpoint ?? "").trim() || PROVIDER_BASE_URLS[provider] || base.baseUrl;
      const keyEnv = (o.standalone_api_key_env ?? "").trim();
      const apiKey = (keyEnv ? process.env[keyEnv] : undefined) || base.apiKey;
      extra.push({
        ...base,
        id: cid,
        backendModel: override || cid,
        baseUrl: endpoint,
        apiKey,
        samplingDefaults: parseSamplingDefaults(o.generation_params ?? {}) ?? base.samplingDefaults,
      });
      continue;
    }
    extra.push({
      ...base,
      id: cid,
      backendModel: override || base.backendModel,
      samplingDefaults: parseSamplingDefaults(o.generation_params ?? {}) ?? base.samplingDefaults,
    });
  }
  return [...baseTiers, ...extra];
}
