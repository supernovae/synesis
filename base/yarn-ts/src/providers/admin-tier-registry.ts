import { z } from "zod";
import {
  FALLBACK_BASE_RATES,
  hasNonZeroRates,
  type PricingRates,
  type PricingSource,
} from "@synesis/telemetry";
import type { AppConfig } from "../config.js";
import {
  normalizeModelCapabilityPreset,
  telemetryProviderForModelCapabilityPreset,
  type ModelArchitectureProfileOverride,
  type ModelCapabilityPresetId,
} from "./model-architecture-profile.js";

const SAFE_ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
function isSafeEnvVarName(name: string): boolean {
  return SAFE_ENV_VAR_PATTERN.test(name);
}

const ArchitectureRiskSchema = z.object({
  longRangeRetrieval: z.string().optional(),
  exactNeedleRecall: z.string().optional(),
  staleContextInterference: z.string().optional(),
  citationDrift: z.string().optional(),
}).strict();

const AttentionCompressionSchema = z.object({
  localPath: z.string().optional(),
  longRangePath: z.string().optional(),
  declaredContextInterpretation: z.string().optional(),
  risk: ArchitectureRiskSchema.optional(),
}).strict();

const ArchitectureTraitsSchema = z.object({
  longTailRetention: z.string().optional(),
  toolCallingReliability: z.string().optional(),
  longContextReliability: z.string().optional(),
  outputThroughputBias: z.string().optional(),
  retrySensitivity: z.string().optional(),
  compactionSensitivity: z.string().optional(),
  longRangeRetrievalReliability: z.string().optional(),
  exactNeedleRecallReliability: z.string().optional(),
  localCoherence: z.string().optional(),
  duplicateContextSensitivity: z.string().optional(),
  staleContextSensitivity: z.string().optional(),
  structuredOutputReliability: z.string().optional(),
  speculativeBoundaryRisk: z.string().optional(),
}).strict();

const ArchitectureRecommendationsSchema = z.object({
  preferMemoryStitching: z.boolean().optional(),
  preferFrontLoadedInstructions: z.boolean().optional(),
  preferRecentToolStateReplay: z.boolean().optional(),
  preferStructuredToolDigests: z.boolean().optional(),
  preferShorterTurns: z.boolean().optional(),
  preferExplicitStateHeaders: z.boolean().optional(),
  preferDeterministicValidation: z.boolean().optional(),
  denseAttentionFacade: z.boolean().optional(),
  semanticStateGraph: z.boolean().optional(),
  activeStateHeader: z.boolean().optional(),
  criticalFactPins: z.boolean().optional(),
  evidenceManifest: z.boolean().optional(),
  contextDedupe: z.boolean().optional(),
  stalenessFiltering: z.boolean().optional(),
  contradictionScanning: z.boolean().optional(),
  longRangeRecallVerification: z.boolean().optional(),
  citationVerification: z.boolean().optional(),
  multipassRetrieval: z.boolean().optional(),
  strictToolBoundaryValidation: z.boolean().optional(),
}).strict();

const ArchitectureProfileOverrideSchema = z.object({
  modelId: z.string().optional(),
  provider: z.string().optional(),
  attention: z.string().optional(),
  activation: z.string().optional(),
  decoding: z.string().optional(),
  declaredContextTokens: z.number().optional(),
  effectiveWorkingContextTokens: z.number().optional(),
  safeInstructionTokens: z.number().optional(),
  safeToolOutputTokens: z.number().optional(),
  attentionCompression: AttentionCompressionSchema.optional(),
  traits: ArchitectureTraitsSchema.optional(),
  recommendations: ArchitectureRecommendationsSchema.optional(),
  notes: z.array(z.string()).max(32).optional(),
}).strict();

const RouteParamsSchema = z.object({
  model: z.string().optional(),
  api_key: z.string().optional(),
  api_base: z.string().optional(),
  max_tokens: z.union([z.number(), z.string()]).optional(),
  temperature: z.union([z.number(), z.string()]).optional(),
  top_p: z.union([z.number(), z.string()]).optional(),
  top_k: z.union([z.number(), z.string()]).optional(),
  min_p: z.union([z.number(), z.string()]).optional(),
  presence_penalty: z.union([z.number(), z.string()]).optional(),
  repetition_penalty: z.union([z.number(), z.string()]).optional(),
  enable_thinking: z.union([z.boolean(), z.number(), z.string()]).optional(),
  reasoning_effort: z.string().optional(),
  model_capability_preset: z.string().optional(),
  model_capability: z.string().optional(),
  capability_preset: z.string().optional(),
  architecture_preset: z.string().optional(),
  default_context_mediation_mode: z.string().optional(),
  architecture_profile: ArchitectureProfileOverrideSchema.optional(),
  architecture_attention: z.string().optional(),
  architecture_activation: z.string().optional(),
  architecture_decoding: z.string().optional(),
  effective_working_context_tokens: z.union([z.number(), z.string()]).optional(),
  safe_instruction_tokens: z.union([z.number(), z.string()]).optional(),
  safe_tool_output_tokens: z.union([z.number(), z.string()]).optional(),
  architecture_compression_local_path: z.string().optional(),
  architecture_compression_long_range_path: z.string().optional(),
  architecture_context_interpretation: z.string().optional(),
  architecture_risk_long_range_retrieval: z.string().optional(),
  architecture_risk_exact_needle_recall: z.string().optional(),
  architecture_risk_stale_context_interference: z.string().optional(),
  architecture_risk_citation_drift: z.string().optional(),
  architecture_long_tail_retention: z.string().optional(),
  architecture_tool_calling_reliability: z.string().optional(),
  architecture_long_context_reliability: z.string().optional(),
  architecture_output_throughput_bias: z.string().optional(),
  architecture_retry_sensitivity: z.string().optional(),
  architecture_compaction_sensitivity: z.string().optional(),
  architecture_long_range_retrieval_reliability: z.string().optional(),
  architecture_exact_needle_recall_reliability: z.string().optional(),
  architecture_local_coherence: z.string().optional(),
  architecture_duplicate_context_sensitivity: z.string().optional(),
  architecture_stale_context_sensitivity: z.string().optional(),
  architecture_structured_output_reliability: z.string().optional(),
  architecture_speculative_boundary_risk: z.string().optional(),
  architecture_dense_attention_facade: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_semantic_state_graph: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_active_state_header: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_critical_fact_pins: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_evidence_manifest: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_context_dedupe: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_staleness_filtering: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_contradiction_scanning: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_long_range_recall_verification: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_citation_verification: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_multipass_retrieval: z.union([z.boolean(), z.number(), z.string()]).optional(),
  architecture_strict_tool_boundary_validation: z.union([z.boolean(), z.number(), z.string()]).optional(),
}).strict();

const RoleSchema = z.object({
  role: z.string(),
  assigned: z.boolean().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  provider: z.string().optional(),
  api_key_env: z.string().optional(),
  route_params: RouteParamsSchema.nullable().optional(),
  adapter_hint: z.string().nullable().optional(),
  context_window: z.number().nullable().optional(),
  id: z.unknown().optional(),
  environment: z.unknown().optional(),
  served_name: z.unknown().optional(),
  status: z.unknown().optional(),
  profile: z.unknown().optional(),
  source: z.unknown().optional(),
  is_active: z.unknown().optional(),
  description: z.unknown().optional(),
  notes: z.unknown().optional(),
  gpu_config: z.unknown().optional(),
  route_model_id: z.unknown().optional(),
  fallbacks: z.unknown().optional(),
  updated_at: z.unknown().optional(),
}).strict().transform(({
  id: _id,
  environment: _environment,
  served_name: _servedName,
  status: _status,
  profile: _profile,
  source: _source,
  is_active: _isActive,
  description: _description,
  notes: _notes,
  gpu_config: _gpuConfig,
  route_model_id: _routeModelId,
  fallbacks: _fallbacks,
  updated_at: _updatedAt,
  ...role
}) => role);

const RolesEnvelopeSchema = z.object({
  roles: z.array(RoleSchema)
}).strict();

const PromptProfileSchema = z.object({
  id: z.number(),
  name: z.string(),
  service: z.string(),
  content: z.string(),
  content_hash: z.string(),
}).strict();

const PromptAssignmentSchema = z.object({
  id: z.number(),
  service: z.string(),
  target_type: z.string(),
  target_value: z.string(),
  profile_id: z.number(),
}).strict();

const PromptSnapshotSchema = z.object({
  service: z.string(),
  profiles: z.array(PromptProfileSchema),
  assignments: z.array(PromptAssignmentSchema),
  updated_at: z.string().nullable().optional(),
}).strict();

const CostRowSchema = z.object({
  role: z.string(),
  input_per_million: z.number().optional(),
  output_per_million: z.number().optional(),
  input_cached_per_million: z.number().nullable().optional(),
  /** When set, estimated cost includes cache write tokens at this $/1M; else cache_creation billed at input rate. */
  input_cache_write_per_million: z.number().nullable().optional(),
  pricing_source: z.string().optional(),
  model: z.unknown().optional(),
  served_name: z.unknown().optional(),
  profile: z.unknown().optional(),
  source: z.unknown().optional(),
  provider: z.unknown().optional(),
  monthly_fixed_cost: z.unknown().optional(),
  cost_formula: z.unknown().optional(),
  notes: z.unknown().optional(),
}).strict().transform(({
  model: _model,
  served_name: _servedName,
  profile: _profile,
  source: _source,
  provider: _provider,
  monthly_fixed_cost: _monthlyFixedCost,
  cost_formula: _costFormula,
  notes: _notes,
  ...cost
}) => cost);

const CostEnvelopeSchema = z.object({
  costs: z.array(CostRowSchema).optional(),
  roles: z.array(CostRowSchema).optional()
}).strict();

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
  /** Optional operator override for Yarn architecture-aware mediation. */
  architectureProfile?: ModelArchitectureProfileOverride | null;
  /** Controlled model-class/version preset. Travels with the model, independent of endpoint host. */
  modelCapabilityPreset?: ModelCapabilityPresetId | null;
  /** Provider tag for cache/usage telemetry when the model preset implies vendor-compatible usage fields. */
  providerTelemetryTag?: string | null;
  /** Optional per-tier default for context mediation when request/user config is absent. */
  defaultContextMediationMode?: string | null;
}

export interface RoleAssignmentConfig {
  role: string;
  assigned: boolean;
  backendModel: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  adapterHint?: string | null;
  modelCapabilityPreset?: ModelCapabilityPresetId | null;
  providerTelemetryTag?: string | null;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n !== undefined && n > 0 ? Math.trunc(n) : undefined;
}

function parseArchitectureProfileOverride(lp: Record<string, unknown>): ModelArchitectureProfileOverride | null {
  const embedded = lp.architecture_profile;
  const out: ModelArchitectureProfileOverride =
    embedded && typeof embedded === "object" && !Array.isArray(embedded)
      ? { ...(embedded as Record<string, unknown>) } as ModelArchitectureProfileOverride
      : {};

  const attention = stringValue(lp.architecture_attention);
  const activation = stringValue(lp.architecture_activation);
  const decoding = stringValue(lp.architecture_decoding);
  const effectiveWorkingContextTokens = numberValue(lp.effective_working_context_tokens);
  const safeInstructionTokens = numberValue(lp.safe_instruction_tokens);
  const safeToolOutputTokens = numberValue(lp.safe_tool_output_tokens);

  if (attention) out.attention = attention as ModelArchitectureProfileOverride["attention"];
  if (activation) out.activation = activation as ModelArchitectureProfileOverride["activation"];
  if (decoding) out.decoding = decoding as ModelArchitectureProfileOverride["decoding"];
  if (effectiveWorkingContextTokens) out.effectiveWorkingContextTokens = effectiveWorkingContextTokens;
  if (safeInstructionTokens) out.safeInstructionTokens = safeInstructionTokens;
  if (safeToolOutputTokens) out.safeToolOutputTokens = safeToolOutputTokens;
  const compressionLocalPath = stringValue(lp.architecture_compression_local_path);
  const compressionLongRangePath = stringValue(lp.architecture_compression_long_range_path);
  const compressionInterpretation = stringValue(lp.architecture_context_interpretation);
  const compressionRiskKeys = [
    "long_range_retrieval",
    "exact_needle_recall",
    "stale_context_interference",
    "citation_drift",
  ] as const;
  const compressionRiskMap: Record<typeof compressionRiskKeys[number], "longRangeRetrieval" | "exactNeedleRecall" | "staleContextInterference" | "citationDrift"> = {
    long_range_retrieval: "longRangeRetrieval",
    exact_needle_recall: "exactNeedleRecall",
    stale_context_interference: "staleContextInterference",
    citation_drift: "citationDrift",
  };
  if (compressionLocalPath || compressionLongRangePath || compressionInterpretation) {
    out.attentionCompression = {
      ...(out.attentionCompression ?? {}),
      ...(compressionLocalPath ? { localPath: compressionLocalPath } : {}),
      ...(compressionLongRangePath ? { longRangePath: compressionLongRangePath } : {}),
      ...(compressionInterpretation ? { declaredContextInterpretation: compressionInterpretation } : {}),
    } as NonNullable<ModelArchitectureProfileOverride["attentionCompression"]>;
  }
  for (const key of compressionRiskKeys) {
    const value = stringValue(lp[`architecture_risk_${key}`]);
    if (!value) continue;
    out.attentionCompression = {
      ...(out.attentionCompression ?? {}),
      risk: {
        ...((out.attentionCompression as { risk?: Record<string, unknown> } | undefined)?.risk ?? {}),
        [compressionRiskMap[key]]: value,
      },
    } as NonNullable<ModelArchitectureProfileOverride["attentionCompression"]>;
  }

  const traitKeys = [
    "long_tail_retention",
    "tool_calling_reliability",
    "long_context_reliability",
    "output_throughput_bias",
    "retry_sensitivity",
    "compaction_sensitivity",
    "long_range_retrieval_reliability",
    "exact_needle_recall_reliability",
    "local_coherence",
    "duplicate_context_sensitivity",
    "stale_context_sensitivity",
    "structured_output_reliability",
    "speculative_boundary_risk",
  ] as const;
  const traitMap: Record<typeof traitKeys[number], keyof NonNullable<ModelArchitectureProfileOverride["traits"]>> = {
    long_tail_retention: "longTailRetention",
    tool_calling_reliability: "toolCallingReliability",
    long_context_reliability: "longContextReliability",
    output_throughput_bias: "outputThroughputBias",
    retry_sensitivity: "retrySensitivity",
    compaction_sensitivity: "compactionSensitivity",
    long_range_retrieval_reliability: "longRangeRetrievalReliability",
    exact_needle_recall_reliability: "exactNeedleRecallReliability",
    local_coherence: "localCoherence",
    duplicate_context_sensitivity: "duplicateContextSensitivity",
    stale_context_sensitivity: "staleContextSensitivity",
    structured_output_reliability: "structuredOutputReliability",
    speculative_boundary_risk: "speculativeBoundaryRisk",
  };
  for (const key of traitKeys) {
    const value = stringValue(lp[`architecture_${key}`]);
    if (!value) continue;
    out.traits = { ...(out.traits ?? {}), [traitMap[key]]: value } as NonNullable<ModelArchitectureProfileOverride["traits"]>;
  }

  const recommendationKeys = [
    "dense_attention_facade",
    "semantic_state_graph",
    "active_state_header",
    "critical_fact_pins",
    "evidence_manifest",
    "context_dedupe",
    "staleness_filtering",
    "contradiction_scanning",
    "long_range_recall_verification",
    "citation_verification",
    "multipass_retrieval",
    "strict_tool_boundary_validation",
  ] as const;
  const recommendationMap: Record<typeof recommendationKeys[number], keyof NonNullable<ModelArchitectureProfileOverride["recommendations"]>> = {
    dense_attention_facade: "denseAttentionFacade",
    semantic_state_graph: "semanticStateGraph",
    active_state_header: "activeStateHeader",
    critical_fact_pins: "criticalFactPins",
    evidence_manifest: "evidenceManifest",
    context_dedupe: "contextDedupe",
    staleness_filtering: "stalenessFiltering",
    contradiction_scanning: "contradictionScanning",
    long_range_recall_verification: "longRangeRecallVerification",
    citation_verification: "citationVerification",
    multipass_retrieval: "multipassRetrieval",
    strict_tool_boundary_validation: "strictToolBoundaryValidation",
  };
  for (const key of recommendationKeys) {
    const value = asBoolean(lp[`architecture_${key}`]);
    if (value === undefined) continue;
    out.recommendations = {
      ...(out.recommendations ?? {}),
      [recommendationMap[key]]: value,
    } as NonNullable<ModelArchitectureProfileOverride["recommendations"]>;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function parseModelCapabilityPreset(lp: Record<string, unknown>): ModelCapabilityPresetId | null {
  return normalizeModelCapabilityPreset(
    lp.model_capability_preset
      ?? lp.model_capability
      ?? lp.capability_preset
      ?? lp.architecture_preset,
  ) ?? null;
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
    const lp = (row.route_params ?? {}) as Record<string, unknown>;
    const samplingDefaults = parseSamplingDefaults(lp);
    const architectureProfile = parseArchitectureProfileOverride(lp);
    const modelCapabilityPreset = parseModelCapabilityPreset(lp);
    const providerTelemetryTag = telemetryProviderForModelCapabilityPreset(modelCapabilityPreset) ?? null;
    const endpoint = (row.endpoint ?? "").trim() || String(lp.api_base ?? "").trim() || PROVIDER_BASE_URLS[provider] || config.SYNESIS_YARN_OPENAI_COMPAT_BASE_URL;
    const keyEnv = (row.api_key_env ?? "").trim();
    const apiKey = (keyEnv && isSafeEnvVarName(keyEnv) ? process.env[keyEnv] : undefined) || config.SYNESIS_YARN_OPENAI_COMPAT_API_KEY;
    roleAssignments.push({
      role: row.role,
      assigned: true,
      backendModel: row.model ?? "",
      baseUrl: endpoint,
      apiKey,
      provider,
      adapterHint: row.adapter_hint ?? null,
      modelCapabilityPreset,
      providerTelemetryTag,
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
      architectureProfile,
      modelCapabilityPreset,
      providerTelemetryTag,
      defaultContextMediationMode: stringValue(lp.default_context_mediation_mode) ?? null,
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
  generation_params: z.object({
    max_tokens: z.number().int().nonnegative().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().nonnegative().optional(),
    min_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    repetition_penalty: z.number().optional(),
    enable_thinking: z.boolean().optional(),
    reasoning_effort: z.string().optional(),
    model_capability_preset: z.string().optional(),
  }).strict().nullable().optional(),
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
      const apiKey = (keyEnv && isSafeEnvVarName(keyEnv) ? process.env[keyEnv] : undefined) || base.apiKey;
      const modelCapabilityPreset = parseModelCapabilityPreset(o.generation_params ?? {});
      extra.push({
        ...base,
        id: cid,
        backendModel: override || cid,
        baseUrl: endpoint,
        apiKey,
        samplingDefaults: parseSamplingDefaults(o.generation_params ?? {}) ?? base.samplingDefaults,
        modelCapabilityPreset: modelCapabilityPreset ?? base.modelCapabilityPreset,
        providerTelemetryTag: modelCapabilityPreset
          ? telemetryProviderForModelCapabilityPreset(modelCapabilityPreset) ?? null
          : base.providerTelemetryTag,
        architectureProfile: parseArchitectureProfileOverride(o.generation_params ?? {}) ?? base.architectureProfile,
      });
      continue;
    }
    const modelCapabilityPreset = parseModelCapabilityPreset(o.generation_params ?? {});
    extra.push({
      ...base,
      id: cid,
      backendModel: override || base.backendModel,
      samplingDefaults: parseSamplingDefaults(o.generation_params ?? {}) ?? base.samplingDefaults,
      modelCapabilityPreset: modelCapabilityPreset ?? base.modelCapabilityPreset,
      providerTelemetryTag: modelCapabilityPreset
        ? telemetryProviderForModelCapabilityPreset(modelCapabilityPreset) ?? null
        : base.providerTelemetryTag,
      architectureProfile: parseArchitectureProfileOverride(o.generation_params ?? {}) ?? base.architectureProfile,
    });
  }
  return [...baseTiers, ...extra];
}
