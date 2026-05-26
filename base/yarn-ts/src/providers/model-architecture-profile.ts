import { createHash } from "node:crypto";

export type AttentionArchitecture =
  | "full_attention"
  | "sliding_window"
  | "mla"
  | "hybrid"
  | "unknown";

export type ActivationArchitecture = "dense" | "moe" | "unknown";

export type DecodingArchitecture =
  | "standard"
  | "mtp"
  | "speculative_friendly"
  | "unknown";

export type ArchitectureStrength = "strong" | "medium" | "weak" | "unknown";
export type ArchitectureLevel = "high" | "medium" | "low" | "unknown";
export type ArchitectureMediationMode = "off" | "observe" | "adapt" | "strict";

export interface ModelArchitectureProfile {
  modelId: string;
  provider?: string;
  attention: AttentionArchitecture;
  activation: ActivationArchitecture;
  decoding: DecodingArchitecture;
  declaredContextTokens?: number;
  effectiveWorkingContextTokens?: number;
  safeInstructionTokens?: number;
  safeToolOutputTokens?: number;
  traits: {
    longTailRetention: ArchitectureStrength;
    toolCallingReliability: ArchitectureStrength;
    longContextReliability: ArchitectureStrength;
    outputThroughputBias: ArchitectureLevel;
    retrySensitivity: ArchitectureLevel;
    compactionSensitivity: ArchitectureLevel;
  };
  recommendations: {
    preferMemoryStitching: boolean;
    preferFrontLoadedInstructions: boolean;
    preferRecentToolStateReplay: boolean;
    preferStructuredToolDigests: boolean;
    preferShorterTurns: boolean;
    preferExplicitStateHeaders: boolean;
    preferDeterministicValidation: boolean;
  };
  notes?: string[];
}

export type ModelArchitectureProfileOverride =
  Partial<Omit<ModelArchitectureProfile, "traits" | "recommendations">>
  & {
    traits?: Partial<ModelArchitectureProfile["traits"]>;
    recommendations?: Partial<ModelArchitectureProfile["recommendations"]>;
  };

export interface ModelExecutionPolicy {
  profileId: string;
  policyHash: string;
  mediationMode: ArchitectureMediationMode;
  attention: AttentionArchitecture;
  activation: ActivationArchitecture;
  decoding: DecodingArchitecture;
  effectiveContextCeilingTokens?: number;
  safeInstructionTokens?: number;
  safeToolOutputTokens?: number;
  compactionMode?: "minimal" | "aggressive";
  preferMemoryStitching: boolean;
  preferFrontLoadedInstructions: boolean;
  preferRecentToolStateReplay: boolean;
  preferStructuredToolDigests: boolean;
  preferShorterTurns: boolean;
  preferExplicitStateHeaders: boolean;
  preferDeterministicValidation: boolean;
  strictStreamToolBoundaryValidation: boolean;
  applyContextBudgetPolicy: boolean;
  applySystemHint: boolean;
  applyGovernorBias: boolean;
  reasons: string[];
}

export interface ArchitectureMediationModeInput {
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  configMode?: string | null;
}

interface ResolveModelArchitectureProfileInput {
  modelId: string;
  provider?: string | null;
  family?: string | null;
  declaredContextTokens?: number | null;
  override?: ModelArchitectureProfileOverride | null;
}

const UNKNOWN_TRAITS: ModelArchitectureProfile["traits"] = {
  longTailRetention: "unknown",
  toolCallingReliability: "unknown",
  longContextReliability: "unknown",
  outputThroughputBias: "unknown",
  retrySensitivity: "unknown",
  compactionSensitivity: "unknown",
};

const UNKNOWN_RECOMMENDATIONS: ModelArchitectureProfile["recommendations"] = {
  preferMemoryStitching: true,
  preferFrontLoadedInstructions: true,
  preferRecentToolStateReplay: true,
  preferStructuredToolDigests: true,
  preferShorterTurns: true,
  preferExplicitStateHeaders: true,
  preferDeterministicValidation: true,
};

export function defaultConservativeArchitectureProfile(
  modelId = "unknown",
  provider?: string | null,
  declaredContextTokens?: number | null,
): ModelArchitectureProfile {
  return {
    modelId,
    provider: provider || undefined,
    attention: "unknown",
    activation: "unknown",
    decoding: "unknown",
    declaredContextTokens: finitePositive(declaredContextTokens),
    effectiveWorkingContextTokens: effectiveContextFromRatio(declaredContextTokens, 0.75),
    safeInstructionTokens: 12_000,
    safeToolOutputTokens: 24_000,
    traits: { ...UNKNOWN_TRAITS, compactionSensitivity: "medium", retrySensitivity: "medium" },
    recommendations: { ...UNKNOWN_RECOMMENDATIONS },
    notes: ["Conservative fallback for unknown model architecture."],
  };
}

export function resolveModelArchitectureProfile(
  input: ResolveModelArchitectureProfileInput,
): ModelArchitectureProfile {
  const modelId = input.modelId || "unknown";
  const provider = input.provider?.trim() || undefined;
  const family = input.family?.trim().toLowerCase() || "";
  const model = modelId.toLowerCase();
  const declared = finitePositive(input.declaredContextTokens);
  let profile = defaultConservativeArchitectureProfile(modelId, provider, declared);

  if (/deepseek/.test(model) || family === "deepseek") {
    profile = {
      ...profile,
      attention: "mla",
      activation: /moe|v3|r1/i.test(model) ? "moe" : "unknown",
      decoding: /mtp/.test(model) ? "mtp" : "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.70),
      safeInstructionTokens: 10_000,
      safeToolOutputTokens: 18_000,
      traits: {
        longTailRetention: "medium",
        toolCallingReliability: "medium",
        longContextReliability: "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: "high",
      },
      recommendations: {
        preferMemoryStitching: true,
        preferFrontLoadedInstructions: true,
        preferRecentToolStateReplay: true,
        preferStructuredToolDigests: true,
        preferShorterTurns: true,
        preferExplicitStateHeaders: true,
        preferDeterministicValidation: true,
      },
      notes: ["MLA-style mediation treats declared context as larger than reliable working memory."],
    };
  } else if (/qwen/.test(model) || family === "qwen3-coder") {
    profile = {
      ...profile,
      attention: "hybrid",
      activation: /moe/.test(model) ? "moe" : "dense",
      decoding: "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.82),
      traits: {
        longTailRetention: "medium",
        toolCallingReliability: "medium",
        longContextReliability: "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: "medium",
      },
      recommendations: {
        ...UNKNOWN_RECOMMENDATIONS,
        preferShorterTurns: true,
        preferDeterministicValidation: true,
      },
      notes: ["Qwen profile keeps existing adapter steering and adds architecture-level validation bias."],
    };
  } else if (/kimi|moonshot|k2[.-]?[56]/.test(model) || family === "kimi") {
    profile = {
      ...profile,
      attention: "hybrid",
      activation: "moe",
      decoding: "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.78),
      safeToolOutputTokens: 20_000,
      traits: {
        longTailRetention: "medium",
        toolCallingReliability: "medium",
        longContextReliability: "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: "high",
      },
      recommendations: { ...UNKNOWN_RECOMMENDATIONS },
      notes: ["Long-context profile uses explicit state replay instead of assuming long-tail recall."],
    };
  } else if (/minimax|abab/.test(model) || family === "minimax") {
    profile = {
      ...profile,
      attention: "hybrid",
      activation: "moe",
      decoding: "speculative_friendly",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.65),
      safeToolOutputTokens: 14_000,
      traits: {
        longTailRetention: "weak",
        toolCallingReliability: "medium",
        longContextReliability: "weak",
        outputThroughputBias: "high",
        retrySensitivity: "high",
        compactionSensitivity: "high",
      },
      recommendations: {
        preferMemoryStitching: true,
        preferFrontLoadedInstructions: true,
        preferRecentToolStateReplay: true,
        preferStructuredToolDigests: true,
        preferShorterTurns: true,
        preferExplicitStateHeaders: true,
        preferDeterministicValidation: true,
      },
      notes: ["Throughput-biased profile favors short turns, explicit task state, and strict validation."],
    };
  } else if (/llama|mixtral|mistral/.test(model)) {
    profile = {
      ...profile,
      attention: /sliding|swa|mistral/.test(model) ? "sliding_window" : "full_attention",
      activation: /mixtral|moe/.test(model) ? "moe" : "dense",
      decoding: "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(
        declared,
        /sliding|swa|mistral/.test(model) ? 0.55 : 0.85,
      ),
      traits: {
        longTailRetention: /sliding|swa|mistral/.test(model) ? "weak" : "medium",
        toolCallingReliability: "medium",
        longContextReliability: /sliding|swa|mistral/.test(model) ? "weak" : "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: /sliding|swa|mistral/.test(model) ? "high" : "medium",
      },
      recommendations: { ...UNKNOWN_RECOMMENDATIONS },
      notes: ["Open-weight profile is cautious unless an admin override declares stronger behavior."],
    };
  } else if (/gpt|openai|o[134]/.test(model) || provider === "openai") {
    profile = {
      ...profile,
      attention: "full_attention",
      activation: "dense",
      decoding: "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.9),
      safeToolOutputTokens: 30_000,
      traits: {
        longTailRetention: "strong",
        toolCallingReliability: "strong",
        longContextReliability: "strong",
        outputThroughputBias: "medium",
        retrySensitivity: "low",
        compactionSensitivity: "low",
      },
      recommendations: {
        preferMemoryStitching: false,
        preferFrontLoadedInstructions: false,
        preferRecentToolStateReplay: false,
        preferStructuredToolDigests: true,
        preferShorterTurns: false,
        preferExplicitStateHeaders: false,
        preferDeterministicValidation: true,
      },
      notes: ["Full-attention default keeps existing context policy unless operators override it."],
    };
  }

  return applyArchitectureOverride(profile, input.override ?? null);
}

export function deriveModelExecutionPolicy(profile: ModelArchitectureProfile): ModelExecutionPolicy {
  const reasons: string[] = [];
  if (profile.effectiveWorkingContextTokens && profile.declaredContextTokens
    && profile.effectiveWorkingContextTokens < profile.declaredContextTokens) {
    reasons.push("effective_context_below_declared");
  }
  if (profile.attention === "sliding_window") reasons.push("sliding_window_attention");
  if (profile.attention === "mla") reasons.push("attention_compression");
  if (profile.activation === "moe") reasons.push("moe_activation");
  if (profile.decoding === "mtp" || profile.decoding === "speculative_friendly") {
    reasons.push("stream_boundary_sensitive_decoding");
  }
  if (profile.traits.longTailRetention === "weak") reasons.push("weak_long_tail_retention");
  if (profile.traits.compactionSensitivity === "high") reasons.push("high_compaction_sensitivity");

  const compactionMode: ModelExecutionPolicy["compactionMode"] =
    profile.traits.compactionSensitivity === "high"
    || profile.traits.longTailRetention === "weak"
    || profile.attention === "sliding_window"
      ? "aggressive"
      : undefined;

  const selected = {
    attention: profile.attention,
    activation: profile.activation,
    decoding: profile.decoding,
    effectiveContextCeilingTokens: profile.effectiveWorkingContextTokens,
    safeInstructionTokens: profile.safeInstructionTokens,
    safeToolOutputTokens: profile.safeToolOutputTokens,
    compactionMode,
    preferMemoryStitching: profile.recommendations.preferMemoryStitching,
    preferFrontLoadedInstructions: profile.recommendations.preferFrontLoadedInstructions,
    preferRecentToolStateReplay: profile.recommendations.preferRecentToolStateReplay,
    preferStructuredToolDigests: profile.recommendations.preferStructuredToolDigests,
    preferShorterTurns: profile.recommendations.preferShorterTurns,
    preferExplicitStateHeaders: profile.recommendations.preferExplicitStateHeaders,
    preferDeterministicValidation: profile.recommendations.preferDeterministicValidation,
    strictStreamToolBoundaryValidation:
      profile.decoding === "mtp"
      || profile.decoding === "speculative_friendly"
      || profile.traits.toolCallingReliability === "weak",
    reasons,
  };

  return {
    profileId: profile.modelId,
    policyHash: hashPolicy(selected),
    mediationMode: "adapt",
    applyContextBudgetPolicy: true,
    applySystemHint: true,
    applyGovernorBias: true,
    ...selected,
  };
}

export function resolveArchitectureMediationMode(
  input: ArchitectureMediationModeInput = {},
): ArchitectureMediationMode {
  const requested = firstString(
    input.metadata?.synesis_architecture_mediation,
    input.metadata?.architecture_mediation,
    input.extraBody?.synesis_architecture_mediation,
    input.extraBody?.architecture_mediation,
    input.configMode,
  );
  if (!requested) return "adapt";
  const normalized = requested.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["off", "none", "disabled", "disable", "hands_off", "passthrough"].includes(normalized)) return "off";
  if (["observe", "observer", "diagnostic", "diagnostics", "trace", "report"].includes(normalized)) return "observe";
  if (["adapt", "adaptive", "auto", "default", "enabled", "on"].includes(normalized)) return "adapt";
  if (["strict", "strong", "enforced", "assertive"].includes(normalized)) return "strict";
  return "adapt";
}

export function applyArchitectureMediationMode(
  policy: ModelExecutionPolicy,
  mode: ArchitectureMediationMode,
): ModelExecutionPolicy {
  const applyContextBudgetPolicy = mode === "adapt" || mode === "strict";
  const applySystemHint = mode === "adapt" || mode === "strict";
  const applyGovernorBias = mode === "adapt" || mode === "strict";
  const strictStreamToolBoundaryValidation =
    policy.strictStreamToolBoundaryValidation || mode === "strict";
  const selected = {
    attention: policy.attention,
    activation: policy.activation,
    decoding: policy.decoding,
    effectiveContextCeilingTokens: applyContextBudgetPolicy ? policy.effectiveContextCeilingTokens : undefined,
    safeInstructionTokens: policy.safeInstructionTokens,
    safeToolOutputTokens: policy.safeToolOutputTokens,
    compactionMode: applyContextBudgetPolicy ? policy.compactionMode : undefined,
    preferMemoryStitching: policy.preferMemoryStitching,
    preferFrontLoadedInstructions: policy.preferFrontLoadedInstructions,
    preferRecentToolStateReplay: policy.preferRecentToolStateReplay,
    preferStructuredToolDigests: policy.preferStructuredToolDigests,
    preferShorterTurns: policy.preferShorterTurns,
    preferExplicitStateHeaders: policy.preferExplicitStateHeaders,
    preferDeterministicValidation: policy.preferDeterministicValidation,
    strictStreamToolBoundaryValidation,
    mediationMode: mode,
    applyContextBudgetPolicy,
    applySystemHint,
    applyGovernorBias,
    reasons: policy.reasons,
  };
  return {
    ...policy,
    mediationMode: mode,
    effectiveContextCeilingTokens: selected.effectiveContextCeilingTokens,
    compactionMode: selected.compactionMode,
    strictStreamToolBoundaryValidation,
    applyContextBudgetPolicy,
    applySystemHint,
    applyGovernorBias,
    reasons: mode === "adapt"
      ? policy.reasons
      : [...new Set([...policy.reasons, `architecture_mediation_${mode}`])],
    policyHash: hashPolicy(selected),
  };
}

export function architecturePolicyTrace(
  profile: ModelArchitectureProfile,
  policy: ModelExecutionPolicy,
): Record<string, unknown> {
  return {
    profile_id: policy.profileId,
    policy_hash: policy.policyHash,
    provider: profile.provider,
    mediation_mode: policy.mediationMode,
    apply_context_budget_policy: policy.applyContextBudgetPolicy,
    apply_system_hint: policy.applySystemHint,
    apply_governor_bias: policy.applyGovernorBias,
    attention: profile.attention,
    activation: profile.activation,
    decoding: profile.decoding,
    declared_context_tokens: profile.declaredContextTokens,
    effective_context_ceiling_tokens: policy.effectiveContextCeilingTokens,
    safe_instruction_tokens: policy.safeInstructionTokens,
    safe_tool_output_tokens: policy.safeToolOutputTokens,
    long_tail_retention: profile.traits.longTailRetention,
    tool_calling_reliability: profile.traits.toolCallingReliability,
    long_context_reliability: profile.traits.longContextReliability,
    output_throughput_bias: profile.traits.outputThroughputBias,
    retry_sensitivity: profile.traits.retrySensitivity,
    compaction_sensitivity: profile.traits.compactionSensitivity,
    compaction_mode: policy.compactionMode,
    prefer_memory_stitching: policy.preferMemoryStitching,
    prefer_recent_tool_state_replay: policy.preferRecentToolStateReplay,
    prefer_structured_tool_digests: policy.preferStructuredToolDigests,
    prefer_explicit_state_headers: policy.preferExplicitStateHeaders,
    prefer_deterministic_validation: policy.preferDeterministicValidation,
    strict_stream_tool_boundary_validation: policy.strictStreamToolBoundaryValidation,
    reasons: policy.reasons,
  };
}

export function buildArchitecturePolicySystemHint(policy: ModelExecutionPolicy): string | null {
  if (!policy.applySystemHint) return null;
  if (
    policy.mediationMode !== "strict"
    && !policy.preferExplicitStateHeaders
    && !policy.preferRecentToolStateReplay
    && !policy.preferShorterTurns
  ) {
    return null;
  }
  const lines = [
    "<SYNESIS_MODEL_EXECUTION_POLICY>",
    `mode=${policy.mediationMode} attention=${policy.attention} activation=${policy.activation} decoding=${policy.decoding}`,
  ];
  if (policy.preferExplicitStateHeaders) {
    lines.push("Use explicit current-state headers and high-signal decisions; do not rely on old long-tail transcript recall.");
  }
  if (policy.preferRecentToolStateReplay) {
    lines.push("Treat the latest task/tool state as authoritative when it conflicts with older narration.");
  }
  if (policy.preferShorterTurns) {
    lines.push("Prefer shorter implementation turns with one concrete action and narrow verification.");
  }
  if (policy.preferDeterministicValidation) {
    lines.push("Validate tool arguments and structured outputs deterministically before retrying.");
  }
  if (policy.mediationMode === "strict") {
    lines.push("Use strict tool-call and stream-boundary validation; repair malformed structure before blind retry.");
  }
  lines.push("</SYNESIS_MODEL_EXECUTION_POLICY>");
  return lines.join("\n");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function applyArchitectureOverride(
  profile: ModelArchitectureProfile,
  override: ModelArchitectureProfileOverride | null,
): ModelArchitectureProfile {
  if (!override) return profile;
  return {
    ...profile,
    ...definedOnly(override),
    traits: {
      ...profile.traits,
      ...definedOnly(override.traits),
    },
    recommendations: {
      ...profile.recommendations,
      ...definedOnly(override.recommendations),
    },
    notes: override.notes ?? profile.notes,
  };
}

function definedOnly<T extends Record<string, unknown> | undefined>(value: T): Partial<NonNullable<T>> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<NonNullable<T>>;
}

function finitePositive(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

function effectiveContextFromRatio(value: unknown, ratio: number): number | undefined {
  const n = finitePositive(value);
  if (!n) return undefined;
  return Math.max(1, Math.floor(n * ratio));
}

function hashPolicy(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}
