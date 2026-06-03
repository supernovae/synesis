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

export const SynesisMetadataSchema = z.object({
  synesis: z.object({
    contextMediation: z.string().optional(),
    architectureProfile: z.string().optional(),
  }).partial().optional(),
}).passthrough();

export const ArchitectureMediationModeInputSchema = z.object({
  headers: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  configMode: z.string().nullable().optional(),
}).partial();

export const ArchitectureProfileSourceInputSchema = z.object({
  headers: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  configSource: z.string().nullable().optional(),
}).partial();

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
  return ArchitectureMediationModeSchema.parse(resolveArchitectureMediationMode(input));
}

export function parseArchitectureProfileSourceContract(
  input: ArchitectureProfileSourceInput = {},
): ArchitectureProfileSourceContract {
  return ArchitectureProfileSourceSchema.parse(resolveArchitectureProfileSource(input));
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
