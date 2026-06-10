import { z } from "zod";
import {
  resolveArchitectureMediationMode,
  resolveArchitectureProfileSource,
  type ArchitectureMediationModeInput,
  type ArchitectureProfileSourceInput,
} from "./architecture-profile.js";
import { MODEL_CAPABILITY_PRESET_IDS, normalizeModelCapabilityPreset } from "./model-capability-preset.js";

export const ARCHITECTURE_MEDIATION_MODES = [
  "off",
  "observe",
  "safe",
  "adaptive",
  "aggressive",
] as const;

export const ARCHITECTURE_PROFILE_SOURCES = [
  "raw",
  "auto",
  "model-registry",
] as const;

export const MODEL_ARCHITECTURE_DIAGNOSTICS_SCHEMA_VERSION = "model_architecture_diagnostics_v1";

export const ArchitectureMediationModeSchema = z.enum(ARCHITECTURE_MEDIATION_MODES);
export const ArchitectureProfileSourceSchema = z.enum(ARCHITECTURE_PROFILE_SOURCES);
export const ModelCapabilityPresetIdSchema = z.enum(MODEL_CAPABILITY_PRESET_IDS);

const SynesisNestedControlsSchema = z.object({
  contextMediation: z.string().max(64).optional(),
  architectureProfile: z.string().max(64).optional(),
}).strict();

const ArchitectureControlFieldsSchema = z.object({
  synesis: SynesisNestedControlsSchema.optional(),
  synesis_context_mediation: z.string().max(64).optional(),
  synesis_memory: z.string().max(64).optional(),
  synesis_work_packet: z.string().max(64).optional(),
  synesis_memory_mediation: z.string().max(64).optional(),
  synesis_architecture_mediation: z.string().max(64).optional(),
  architecture_mediation: z.string().max(64).optional(),
  synesis_architecture_profile: z.string().max(64).optional(),
}).strict();

const SynesisIdentifierFieldsSchema = z.object({
  request_id: z.string().max(256).optional(),
  trace_id: z.string().max(256).optional(),
  session_id: z.string().max(256).optional(),
  conversation_id: z.string().max(256).optional(),
  synesis_conversation_id: z.string().max(256).optional(),
}).strict();

export const SynesisMetadataSchema = ArchitectureControlFieldsSchema.merge(SynesisIdentifierFieldsSchema);

const HeaderValueSchema = z.union([
  z.string().max(128),
  z.array(z.string().max(128)).max(8),
]);

const ArchitectureHeadersSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized === "x-synesis-context-mediation" || normalized === "x-synesis-architecture-profile") {
      out[normalized] = item;
    }
  }
  return out;
}, z.object({
  "x-synesis-context-mediation": HeaderValueSchema.optional(),
  "x-synesis-architecture-profile": HeaderValueSchema.optional(),
}).strict());

const ArchitectureControlInputSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ArchitectureControlFieldsSchema.shape)) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}, ArchitectureControlFieldsSchema);

export const ArchitectureMediationModeInputSchema = z.object({
  headers: ArchitectureHeadersSchema.optional(),
  metadata: ArchitectureControlFieldsSchema.optional(),
  extraBody: ArchitectureControlInputSchema.optional(),
  configMode: z.string().max(64).nullable().optional(),
}).strict();

export const ArchitectureProfileSourceInputSchema = z.object({
  headers: ArchitectureHeadersSchema.optional(),
  metadata: ArchitectureControlFieldsSchema.optional(),
  extraBody: ArchitectureControlInputSchema.optional(),
  configSource: z.string().max(64).nullable().optional(),
}).strict();

const ArchitectureLevelSchema = z.string().max(64);
const ArchitectureBoolGroupSchema = z.object({
  activeStateHeader: z.boolean().optional(),
  applyBudgetPolicy: z.boolean().optional(),
  citationVerification: z.boolean().optional(),
  contradictionScanning: z.boolean().optional(),
  criticalFactPins: z.boolean().optional(),
  dedupe: z.boolean().optional(),
  enabled: z.boolean().optional(),
  evidenceManifest: z.boolean().optional(),
  longRangeRecallVerification: z.boolean().optional(),
  missingReferenceVerification: z.boolean().optional(),
  quoteCitationVerification: z.boolean().optional(),
  recentToolTruth: z.boolean().optional(),
  retrieveAnswerVerifyRepair: z.boolean().optional(),
  semanticBlockCanonicalization: z.boolean().optional(),
  stalenessFiltering: z.boolean().optional(),
  strictToolBoundaryValidation: z.boolean().optional(),
  structuredOutputVerification: z.boolean().optional(),
  tailInjection: z.boolean().optional(),
}).strict();

const AttentionCompressionTraceSchema = z.object({
  localPath: ArchitectureLevelSchema,
  longRangePath: ArchitectureLevelSchema,
  declaredContextInterpretation: ArchitectureLevelSchema,
  risk: z.object({
    longRangeRetrieval: ArchitectureLevelSchema,
    exactNeedleRecall: ArchitectureLevelSchema,
    staleContextInterference: ArchitectureLevelSchema,
    citationDrift: ArchitectureLevelSchema,
  }).strict(),
}).strict();

const ContextBudgetTraceSchema = z.object({
  declaredContextTokens: z.number().int().positive().optional(),
  effectiveWorkingContextTokens: z.number().int().positive().optional(),
  interpretation: ArchitectureLevelSchema,
  applyBudgetPolicy: z.boolean(),
  safeInstructionTokens: z.number().int().positive().optional(),
  safeToolOutputTokens: z.number().int().positive().optional(),
}).strict();

const MultipassTraceSchema = z.object({
  enabled: z.boolean(),
  maxRepairPasses: z.union([z.literal(0), z.literal(1)]),
  retrieveAnswerVerifyRepair: z.boolean(),
}).strict();

const ModelArchitectureTraceSchema = z.object({
  profile_id: z.string().max(256),
  policy_hash: z.string().max(128),
  provider: z.string().max(128).optional(),
  mediation_mode: ArchitectureMediationModeSchema,
  apply_context_budget_policy: z.boolean(),
  apply_system_hint: z.boolean(),
  apply_governor_bias: z.boolean(),
  attention: ArchitectureLevelSchema,
  activation: ArchitectureLevelSchema,
  decoding: ArchitectureLevelSchema,
  attention_compression: AttentionCompressionTraceSchema,
  context_budget: ContextBudgetTraceSchema,
  canonicalization: ArchitectureBoolGroupSchema,
  state_reinforcement: ArchitectureBoolGroupSchema,
  retrieval: ArchitectureBoolGroupSchema,
  validation: ArchitectureBoolGroupSchema,
  multipass: MultipassTraceSchema,
  declared_context_tokens: z.number().int().positive().optional(),
  declared_context_interpretation: ArchitectureLevelSchema,
  effective_context_ceiling_tokens: z.number().int().positive().optional(),
  safe_instruction_tokens: z.number().int().positive().optional(),
  safe_tool_output_tokens: z.number().int().positive().optional(),
  long_tail_retention: ArchitectureLevelSchema,
  tool_calling_reliability: ArchitectureLevelSchema,
  long_context_reliability: ArchitectureLevelSchema,
  output_throughput_bias: ArchitectureLevelSchema,
  retry_sensitivity: ArchitectureLevelSchema,
  compaction_sensitivity: ArchitectureLevelSchema,
  long_range_retrieval_reliability: ArchitectureLevelSchema,
  exact_needle_recall_reliability: ArchitectureLevelSchema,
  local_coherence: ArchitectureLevelSchema,
  duplicate_context_sensitivity: ArchitectureLevelSchema,
  stale_context_sensitivity: ArchitectureLevelSchema,
  structured_output_reliability: ArchitectureLevelSchema,
  speculative_boundary_risk: ArchitectureLevelSchema,
  compaction_mode: z.enum(["minimal", "aggressive"]).optional(),
  prefer_memory_stitching: z.boolean(),
  prefer_recent_tool_state_replay: z.boolean(),
  prefer_structured_tool_digests: z.boolean(),
  prefer_explicit_state_headers: z.boolean(),
  prefer_deterministic_validation: z.boolean(),
  dense_attention_facade: z.boolean(),
  semantic_state_graph: z.boolean(),
  active_state_header: z.boolean(),
  critical_fact_pins: z.boolean(),
  evidence_manifest: z.boolean(),
  context_dedupe: z.boolean(),
  staleness_filtering: z.boolean(),
  long_range_recall_verification: z.boolean(),
  citation_verification: z.boolean(),
  multipass_retrieval: z.boolean(),
  strict_stream_tool_boundary_validation: z.boolean(),
  reasons: z.array(z.string().max(128)).max(64),
}).strict();

const ModelArchitectureDiagnosticSchema = z.object({
  model_id: z.string(),
  resolved: z.boolean(),
  tier_id: z.string().optional(),
  backend_model: z.string(),
  provider: z.string().optional(),
  adapter_family: z.string(),
  model_capability_preset: z.string().nullable().optional(),
  declared_context_tokens: z.number().int().positive().optional(),
  override_applied: z.boolean(),
  architecture: ModelArchitectureTraceSchema,
  profile_notes: z.array(z.string()).optional(),
});

export const ModelArchitectureDiagnosticsV1Schema = z.object({
  schema_version: z.literal(MODEL_ARCHITECTURE_DIAGNOSTICS_SCHEMA_VERSION),
  count: z.number().int().nonnegative(),
  models: z.array(ModelArchitectureDiagnosticSchema),
}).superRefine((value, ctx) => {
  if (value.count !== value.models.length) {
    ctx.addIssue({
      code: "custom",
      path: ["count"],
      message: "count must match models.length",
    });
  }
});

export type ArchitectureMediationModeContract = z.infer<typeof ArchitectureMediationModeSchema>;
export type ArchitectureProfileSourceContract = z.infer<typeof ArchitectureProfileSourceSchema>;
export type SynesisMetadataContract = z.infer<typeof SynesisMetadataSchema>;
export type ModelArchitectureDiagnosticsV1 = z.infer<typeof ModelArchitectureDiagnosticsV1Schema>;

export function parseArchitectureMediationModeContract(
  input: ArchitectureMediationModeInput = {},
): ArchitectureMediationModeContract {
  const parsed = ArchitectureMediationModeInputSchema.parse(input);
  return ArchitectureMediationModeSchema.parse(resolveArchitectureMediationMode(parsed));
}

export function parseArchitectureProfileSourceContract(
  input: ArchitectureProfileSourceInput = {},
): ArchitectureProfileSourceContract {
  const parsed = ArchitectureProfileSourceInputSchema.parse(input);
  return ArchitectureProfileSourceSchema.parse(resolveArchitectureProfileSource(parsed));
}

export function parseModelCapabilityPresetContract(value: unknown): z.infer<typeof ModelCapabilityPresetIdSchema> | undefined {
  const normalized = normalizeModelCapabilityPreset(value);
  return normalized ? ModelCapabilityPresetIdSchema.parse(normalized) : undefined;
}

export function parseSynesisMetadataContract(value: unknown): SynesisMetadataContract {
  return SynesisMetadataSchema.parse(value ?? {});
}

export function parseModelArchitectureDiagnosticsV1(value: unknown): ModelArchitectureDiagnosticsV1 {
  return ModelArchitectureDiagnosticsV1Schema.parse(value);
}
