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
  architecture: z.record(z.string(), z.unknown()),
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
