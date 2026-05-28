import { createHash } from "node:crypto";

export type AttentionArchitecture =
  | "full_attention"
  | "sliding_window"
  | "global_local_hybrid"
  | "mla"
  | "compressed_sparse_attention"
  | "heavily_compressed_attention"
  | "hybrid_compressed_attention"
  | "unknown";

export type ActivationArchitecture = "dense" | "moe" | "unknown";

export type DecodingArchitecture =
  | "standard"
  | "mtp"
  | "speculative_friendly"
  | "unknown";

export type ArchitectureStrength = "strong" | "medium" | "weak" | "unknown";
export type ArchitectureLevel = "high" | "medium" | "low" | "unknown";
export type ArchitectureMediationMode = "off" | "observe" | "safe" | "adaptive" | "aggressive";
export type ArchitectureProfileSource = "raw" | "auto" | "model-registry";

export interface AttentionCompressionProfile {
  localPath: "dense" | "sliding_window" | "global_local" | "compressed" | "unknown";
  longRangePath: "dense" | "latent_compressed" | "sparse_compressed" | "retrieval_compressed" | "unknown";
  declaredContextInterpretation: "dense_working_memory" | "storage_with_working_set" | "unknown";
  risk: {
    longRangeRetrieval: ArchitectureLevel;
    exactNeedleRecall: ArchitectureLevel;
    staleContextInterference: ArchitectureLevel;
    citationDrift: ArchitectureLevel;
  };
}

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
  attentionCompression: AttentionCompressionProfile;
  traits: {
    longTailRetention: ArchitectureStrength;
    toolCallingReliability: ArchitectureStrength;
    longContextReliability: ArchitectureStrength;
    outputThroughputBias: ArchitectureLevel;
    retrySensitivity: ArchitectureLevel;
    compactionSensitivity: ArchitectureLevel;
    longRangeRetrievalReliability: ArchitectureStrength;
    exactNeedleRecallReliability: ArchitectureStrength;
    localCoherence: ArchitectureStrength;
    duplicateContextSensitivity: ArchitectureLevel;
    staleContextSensitivity: ArchitectureLevel;
    structuredOutputReliability: ArchitectureStrength;
    speculativeBoundaryRisk: ArchitectureLevel;
  };
  recommendations: {
    preferMemoryStitching: boolean;
    preferFrontLoadedInstructions: boolean;
    preferRecentToolStateReplay: boolean;
    preferStructuredToolDigests: boolean;
    preferShorterTurns: boolean;
    preferExplicitStateHeaders: boolean;
    preferDeterministicValidation: boolean;
    denseAttentionFacade: boolean;
    semanticStateGraph: boolean;
    activeStateHeader: boolean;
    criticalFactPins: boolean;
    evidenceManifest: boolean;
    contextDedupe: boolean;
    stalenessFiltering: boolean;
    contradictionScanning: boolean;
    longRangeRecallVerification: boolean;
    citationVerification: boolean;
    multipassRetrieval: boolean;
    strictToolBoundaryValidation: boolean;
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
  attentionCompression: AttentionCompressionProfile;
  contextBudget: {
    declaredContextTokens?: number;
    effectiveWorkingContextTokens?: number;
    interpretation: AttentionCompressionProfile["declaredContextInterpretation"];
    applyBudgetPolicy: boolean;
    safeInstructionTokens?: number;
    safeToolOutputTokens?: number;
  };
  canonicalization: {
    semanticBlockCanonicalization: boolean;
    dedupe: boolean;
    stalenessFiltering: boolean;
    contradictionScanning: boolean;
  };
  stateReinforcement: {
    activeStateHeader: boolean;
    criticalFactPins: boolean;
    recentToolTruth: boolean;
    tailInjection: boolean;
  };
  retrieval: {
    evidenceManifest: boolean;
    longRangeRecallVerification: boolean;
    citationVerification: boolean;
  };
  validation: {
    missingReferenceVerification: boolean;
    quoteCitationVerification: boolean;
    structuredOutputVerification: boolean;
    strictToolBoundaryValidation: boolean;
  };
  multipass: {
    enabled: boolean;
    maxRepairPasses: 0 | 1;
    retrieveAnswerVerifyRepair: boolean;
  };
  trace: {
    profileId: string;
    policyHash: string;
    reasons: string[];
  };
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
  headers?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  configMode?: string | null;
}

export interface ArchitectureProfileSourceInput {
  headers?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  configSource?: string | null;
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
  longRangeRetrievalReliability: "unknown",
  exactNeedleRecallReliability: "unknown",
  localCoherence: "unknown",
  duplicateContextSensitivity: "unknown",
  staleContextSensitivity: "unknown",
  structuredOutputReliability: "unknown",
  speculativeBoundaryRisk: "unknown",
};

const UNKNOWN_RECOMMENDATIONS: ModelArchitectureProfile["recommendations"] = {
  preferMemoryStitching: true,
  preferFrontLoadedInstructions: true,
  preferRecentToolStateReplay: true,
  preferStructuredToolDigests: true,
  preferShorterTurns: true,
  preferExplicitStateHeaders: true,
  preferDeterministicValidation: true,
  denseAttentionFacade: true,
  semanticStateGraph: true,
  activeStateHeader: true,
  criticalFactPins: true,
  evidenceManifest: true,
  contextDedupe: true,
  stalenessFiltering: true,
  contradictionScanning: true,
  longRangeRecallVerification: true,
  citationVerification: true,
  multipassRetrieval: false,
  strictToolBoundaryValidation: true,
};

const UNKNOWN_COMPRESSION: AttentionCompressionProfile = {
  localPath: "unknown",
  longRangePath: "unknown",
  declaredContextInterpretation: "unknown",
  risk: {
    longRangeRetrieval: "unknown",
    exactNeedleRecall: "unknown",
    staleContextInterference: "unknown",
    citationDrift: "unknown",
  },
};

const FULL_ATTENTION_COMPRESSION: AttentionCompressionProfile = {
  localPath: "dense",
  longRangePath: "dense",
  declaredContextInterpretation: "dense_working_memory",
  risk: {
    longRangeRetrieval: "low",
    exactNeedleRecall: "low",
    staleContextInterference: "low",
    citationDrift: "low",
  },
};

const HYBRID_COMPRESSED_COMPRESSION: AttentionCompressionProfile = {
  localPath: "global_local",
  longRangePath: "retrieval_compressed",
  declaredContextInterpretation: "storage_with_working_set",
  risk: {
    longRangeRetrieval: "high",
    exactNeedleRecall: "high",
    staleContextInterference: "high",
    citationDrift: "medium",
  },
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
    attentionCompression: UNKNOWN_COMPRESSION,
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
      activation: /moe|v[34]|r1/i.test(model) ? "moe" : "unknown",
      decoding: /mtp/.test(model) ? "mtp" : "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.70),
      safeInstructionTokens: 10_000,
      safeToolOutputTokens: 18_000,
      attentionCompression: {
        ...HYBRID_COMPRESSED_COMPRESSION,
        longRangePath: "latent_compressed",
      },
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: "medium",
        toolCallingReliability: "medium",
        longContextReliability: "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: "high",
        longRangeRetrievalReliability: "medium",
        exactNeedleRecallReliability: "medium",
        localCoherence: "medium",
        duplicateContextSensitivity: "high",
        staleContextSensitivity: "high",
        structuredOutputReliability: "medium",
      },
      recommendations: {
        ...UNKNOWN_RECOMMENDATIONS,
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
  } else if (/xiaomi|mimo/.test(model) || family === "xiaomi") {
    const isFlash = /flash/.test(model);
    profile = {
      ...profile,
      attention: isFlash ? "sliding_window" : "hybrid_compressed_attention",
      activation: "moe",
      decoding: isFlash ? "mtp" : "speculative_friendly",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, isFlash ? 0.58 : 0.72),
      safeInstructionTokens: isFlash ? 8_000 : 12_000,
      safeToolOutputTokens: isFlash ? 14_000 : 22_000,
      attentionCompression: isFlash
        ? {
            ...HYBRID_COMPRESSED_COMPRESSION,
            localPath: "sliding_window",
            longRangePath: "sparse_compressed",
          }
        : HYBRID_COMPRESSED_COMPRESSION,
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: isFlash ? "weak" : "medium",
        toolCallingReliability: "medium",
        longContextReliability: isFlash ? "weak" : "medium",
        outputThroughputBias: isFlash ? "high" : "medium",
        retrySensitivity: "high",
        compactionSensitivity: "high",
        longRangeRetrievalReliability: isFlash ? "weak" : "medium",
        exactNeedleRecallReliability: isFlash ? "weak" : "medium",
        localCoherence: "medium",
        duplicateContextSensitivity: "high",
        staleContextSensitivity: "high",
        structuredOutputReliability: "medium",
        speculativeBoundaryRisk: "high",
      },
      recommendations: {
        ...UNKNOWN_RECOMMENDATIONS,
        preferMemoryStitching: true,
        preferFrontLoadedInstructions: true,
        preferRecentToolStateReplay: true,
        preferStructuredToolDigests: true,
        preferShorterTurns: true,
        preferExplicitStateHeaders: true,
        preferDeterministicValidation: true,
      },
      notes: [
        isFlash
          ? "MiMo Flash profile treats SWA/MTP behavior as short-turn and boundary-validation sensitive."
          : "MiMo V2.5 profile uses explicit state replay for long agent sessions and MoE determinism.",
      ],
    };
  } else if (/qwen/.test(model) || family === "qwen3-coder") {
    profile = {
      ...profile,
      attention: "global_local_hybrid",
      activation: /moe/.test(model) ? "moe" : "dense",
      decoding: "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.82),
      attentionCompression: {
        ...HYBRID_COMPRESSED_COMPRESSION,
        localPath: "global_local",
        longRangePath: "sparse_compressed",
        risk: { ...HYBRID_COMPRESSED_COMPRESSION.risk, longRangeRetrieval: "medium", exactNeedleRecall: "medium" },
      },
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: "medium",
        toolCallingReliability: "medium",
        longContextReliability: "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: "medium",
        longRangeRetrievalReliability: "medium",
        exactNeedleRecallReliability: "medium",
        localCoherence: "medium",
        duplicateContextSensitivity: "medium",
        staleContextSensitivity: "medium",
        structuredOutputReliability: "medium",
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
      attention: "hybrid_compressed_attention",
      activation: "moe",
      decoding: "standard",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.78),
      safeToolOutputTokens: 20_000,
      attentionCompression: HYBRID_COMPRESSED_COMPRESSION,
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: "medium",
        toolCallingReliability: "medium",
        longContextReliability: "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: "high",
        longRangeRetrievalReliability: "medium",
        exactNeedleRecallReliability: "medium",
        localCoherence: "medium",
        duplicateContextSensitivity: "high",
        staleContextSensitivity: "high",
        structuredOutputReliability: "medium",
      },
      recommendations: { ...UNKNOWN_RECOMMENDATIONS },
      notes: ["Long-context profile uses explicit state replay instead of assuming long-tail recall."],
    };
  } else if (/minimax|abab/.test(model) || family === "minimax") {
    profile = {
      ...profile,
      attention: "heavily_compressed_attention",
      activation: "moe",
      decoding: "speculative_friendly",
      effectiveWorkingContextTokens: effectiveContextFromRatio(declared, 0.65),
      safeToolOutputTokens: 14_000,
      attentionCompression: {
        ...HYBRID_COMPRESSED_COMPRESSION,
        localPath: "compressed",
        longRangePath: "retrieval_compressed",
      },
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: "weak",
        toolCallingReliability: "medium",
        longContextReliability: "weak",
        outputThroughputBias: "high",
        retrySensitivity: "high",
        compactionSensitivity: "high",
        longRangeRetrievalReliability: "weak",
        exactNeedleRecallReliability: "weak",
        localCoherence: "medium",
        duplicateContextSensitivity: "high",
        staleContextSensitivity: "high",
        structuredOutputReliability: "medium",
        speculativeBoundaryRisk: "high",
      },
      recommendations: {
        ...UNKNOWN_RECOMMENDATIONS,
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
      attentionCompression: /sliding|swa|mistral/.test(model)
        ? {
            ...HYBRID_COMPRESSED_COMPRESSION,
            localPath: "sliding_window",
            longRangePath: "sparse_compressed",
          }
        : FULL_ATTENTION_COMPRESSION,
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: /sliding|swa|mistral/.test(model) ? "weak" : "medium",
        toolCallingReliability: "medium",
        longContextReliability: /sliding|swa|mistral/.test(model) ? "weak" : "medium",
        outputThroughputBias: "medium",
        retrySensitivity: "medium",
        compactionSensitivity: /sliding|swa|mistral/.test(model) ? "high" : "medium",
        longRangeRetrievalReliability: /sliding|swa|mistral/.test(model) ? "weak" : "medium",
        exactNeedleRecallReliability: /sliding|swa|mistral/.test(model) ? "weak" : "medium",
        localCoherence: "medium",
        duplicateContextSensitivity: /sliding|swa|mistral/.test(model) ? "high" : "medium",
        staleContextSensitivity: /sliding|swa|mistral/.test(model) ? "high" : "medium",
        structuredOutputReliability: "medium",
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
      attentionCompression: FULL_ATTENTION_COMPRESSION,
      traits: {
        ...UNKNOWN_TRAITS,
        longTailRetention: "strong",
        toolCallingReliability: "strong",
        longContextReliability: "strong",
        outputThroughputBias: "medium",
        retrySensitivity: "low",
        compactionSensitivity: "low",
        longRangeRetrievalReliability: "strong",
        exactNeedleRecallReliability: "strong",
        localCoherence: "strong",
        duplicateContextSensitivity: "low",
        staleContextSensitivity: "low",
        structuredOutputReliability: "strong",
        speculativeBoundaryRisk: "low",
      },
      recommendations: {
        ...UNKNOWN_RECOMMENDATIONS,
        preferMemoryStitching: false,
        preferFrontLoadedInstructions: false,
        preferRecentToolStateReplay: false,
        preferStructuredToolDigests: true,
        preferShorterTurns: false,
        preferExplicitStateHeaders: false,
        preferDeterministicValidation: true,
        denseAttentionFacade: false,
        semanticStateGraph: false,
        activeStateHeader: false,
        criticalFactPins: false,
        evidenceManifest: false,
        contextDedupe: true,
        stalenessFiltering: false,
        contradictionScanning: false,
        longRangeRecallVerification: false,
        citationVerification: true,
        multipassRetrieval: false,
        strictToolBoundaryValidation: false,
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
  if (
    profile.attention === "mla"
    || profile.attention === "compressed_sparse_attention"
    || profile.attention === "heavily_compressed_attention"
    || profile.attention === "hybrid_compressed_attention"
  ) reasons.push("attention_compression");
  if (profile.attentionCompression.declaredContextInterpretation === "storage_with_working_set") {
    reasons.push("declared_context_as_storage");
  }
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

  const contextBudget: ModelExecutionPolicy["contextBudget"] = {
    declaredContextTokens: profile.declaredContextTokens,
    effectiveWorkingContextTokens: profile.effectiveWorkingContextTokens,
    interpretation: profile.attentionCompression.declaredContextInterpretation,
    applyBudgetPolicy: true,
    safeInstructionTokens: profile.safeInstructionTokens,
    safeToolOutputTokens: profile.safeToolOutputTokens,
  };
  const canonicalization: ModelExecutionPolicy["canonicalization"] = {
    semanticBlockCanonicalization: profile.recommendations.semanticStateGraph,
    dedupe: profile.recommendations.contextDedupe,
    stalenessFiltering: profile.recommendations.stalenessFiltering,
    contradictionScanning: profile.recommendations.contradictionScanning,
  };
  const stateReinforcement: ModelExecutionPolicy["stateReinforcement"] = {
    activeStateHeader: profile.recommendations.activeStateHeader,
    criticalFactPins: profile.recommendations.criticalFactPins,
    recentToolTruth: profile.recommendations.preferRecentToolStateReplay,
    tailInjection: profile.recommendations.preferExplicitStateHeaders,
  };
  const retrieval: ModelExecutionPolicy["retrieval"] = {
    evidenceManifest: profile.recommendations.evidenceManifest,
    longRangeRecallVerification: profile.recommendations.longRangeRecallVerification,
    citationVerification: profile.recommendations.citationVerification,
  };
  const validation: ModelExecutionPolicy["validation"] = {
    missingReferenceVerification: profile.recommendations.longRangeRecallVerification,
    quoteCitationVerification: profile.recommendations.citationVerification,
    structuredOutputVerification: profile.recommendations.preferDeterministicValidation,
    strictToolBoundaryValidation:
      profile.recommendations.strictToolBoundaryValidation
      || profile.decoding === "mtp"
      || profile.decoding === "speculative_friendly"
      || profile.traits.toolCallingReliability === "weak",
  };
  const multipass: ModelExecutionPolicy["multipass"] = {
    enabled: profile.recommendations.multipassRetrieval,
    maxRepairPasses: profile.recommendations.multipassRetrieval ? 1 : 0,
    retrieveAnswerVerifyRepair: false,
  };

  const selected = {
    attention: profile.attention,
    activation: profile.activation,
    decoding: profile.decoding,
    attentionCompression: profile.attentionCompression,
    contextBudget,
    canonicalization,
    stateReinforcement,
    retrieval,
    validation,
    multipass,
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
    strictStreamToolBoundaryValidation: validation.strictToolBoundaryValidation,
    reasons,
  };

  return {
    profileId: profile.modelId,
    policyHash: hashPolicy(selected),
    mediationMode: "adaptive",
    applyContextBudgetPolicy: true,
    applySystemHint: true,
    applyGovernorBias: true,
    trace: {
      profileId: profile.modelId,
      policyHash: hashPolicy(selected),
      reasons,
    },
    ...selected,
  };
}

export function resolveArchitectureMediationMode(
  input: ArchitectureMediationModeInput = {},
): ArchitectureMediationMode {
  const requested = firstString(
    headerValue(input.headers, "x-synesis-context-mediation"),
    nestedSynesisString(input.metadata, "contextMediation"),
    nestedSynesisString(input.extraBody, "contextMediation"),
    input.metadata?.synesis_context_mediation,
    input.extraBody?.synesis_context_mediation,
    input.metadata?.synesis_memory,
    input.metadata?.synesis_work_packet,
    input.metadata?.synesis_memory_mediation,
    input.extraBody?.synesis_memory,
    input.extraBody?.synesis_work_packet,
    input.extraBody?.synesis_memory_mediation,
    input.metadata?.synesis_architecture_mediation,
    input.metadata?.architecture_mediation,
    input.extraBody?.synesis_architecture_mediation,
    input.extraBody?.architecture_mediation,
    input.configMode,
  );
  if (!requested) return "adaptive";
  const normalized = requested.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["off", "none", "disabled", "disable", "hands_off", "passthrough"].includes(normalized)) return "off";
  if (["observe", "observer", "diagnostic", "diagnostics", "trace", "report"].includes(normalized)) return "observe";
  if (["safe", "guarded", "conservative"].includes(normalized)) return "safe";
  if (["adapt", "adaptive", "auto", "default", "enabled", "on"].includes(normalized)) return "adaptive";
  if (["aggressive", "strict", "strong", "enforced", "assertive", "always"].includes(normalized)) return "aggressive";
  return "adaptive";
}

export function resolveArchitectureProfileSource(
  input: ArchitectureProfileSourceInput = {},
): ArchitectureProfileSource {
  const requested = firstString(
    headerValue(input.headers, "x-synesis-architecture-profile"),
    nestedSynesisString(input.metadata, "architectureProfile"),
    nestedSynesisString(input.extraBody, "architectureProfile"),
    input.metadata?.synesis_architecture_profile,
    input.extraBody?.synesis_architecture_profile,
    input.configSource,
  );
  if (!requested) return "model-registry";
  const normalized = requested.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "raw" || normalized === "none" || normalized === "passthrough") return "raw";
  if (normalized === "auto" || normalized === "infer" || normalized === "inferred") return "auto";
  return "model-registry";
}

export function applyArchitectureMediationMode(
  policy: ModelExecutionPolicy,
  mode: ArchitectureMediationMode,
): ModelExecutionPolicy {
  const applyContextBudgetPolicy = mode === "safe" || mode === "adaptive" || mode === "aggressive";
  const applySystemHint = mode === "adaptive" || mode === "aggressive";
  const applyGovernorBias = mode === "safe" || mode === "adaptive" || mode === "aggressive";
  const strictStreamToolBoundaryValidation =
    policy.strictStreamToolBoundaryValidation || mode === "safe" || mode === "aggressive";
  const contextBudget: ModelExecutionPolicy["contextBudget"] = {
    ...policy.contextBudget,
    applyBudgetPolicy: applyContextBudgetPolicy,
    effectiveWorkingContextTokens: applyContextBudgetPolicy ? policy.contextBudget.effectiveWorkingContextTokens : undefined,
  };
  const canonicalization: ModelExecutionPolicy["canonicalization"] = {
    semanticBlockCanonicalization: mode !== "off" && mode !== "observe" && policy.canonicalization.semanticBlockCanonicalization,
    dedupe: mode === "safe" || mode === "adaptive" || mode === "aggressive"
      ? policy.canonicalization.dedupe
      : false,
    stalenessFiltering: mode === "safe" || mode === "adaptive" || mode === "aggressive"
      ? policy.canonicalization.stalenessFiltering
      : false,
    contradictionScanning: mode === "adaptive" || mode === "aggressive"
      ? policy.canonicalization.contradictionScanning
      : false,
  };
  const stateReinforcement: ModelExecutionPolicy["stateReinforcement"] = {
    activeStateHeader: (mode === "adaptive" || mode === "aggressive") && policy.stateReinforcement.activeStateHeader,
    criticalFactPins: (mode === "adaptive" || mode === "aggressive" || mode === "observe") && policy.stateReinforcement.criticalFactPins,
    recentToolTruth: (mode === "adaptive" || mode === "aggressive" || mode === "observe") && policy.stateReinforcement.recentToolTruth,
    tailInjection: (mode === "adaptive" || mode === "aggressive") && policy.stateReinforcement.tailInjection,
  };
  const retrieval: ModelExecutionPolicy["retrieval"] = {
    evidenceManifest: (mode === "adaptive" || mode === "aggressive" || mode === "observe") && policy.retrieval.evidenceManifest,
    longRangeRecallVerification: (mode === "adaptive" || mode === "aggressive") && policy.retrieval.longRangeRecallVerification,
    citationVerification: (mode === "adaptive" || mode === "aggressive") && policy.retrieval.citationVerification,
  };
  const validation: ModelExecutionPolicy["validation"] = {
    ...policy.validation,
    missingReferenceVerification: (mode === "adaptive" || mode === "aggressive") && policy.validation.missingReferenceVerification,
    quoteCitationVerification: (mode === "adaptive" || mode === "aggressive") && policy.validation.quoteCitationVerification,
    structuredOutputVerification: (mode === "adaptive" || mode === "aggressive") && policy.validation.structuredOutputVerification,
    strictToolBoundaryValidation: strictStreamToolBoundaryValidation,
  };
  const multipass: ModelExecutionPolicy["multipass"] = {
    enabled: mode === "adaptive" || mode === "aggressive",
    maxRepairPasses: mode === "adaptive" || mode === "aggressive" ? 1 : 0,
    retrieveAnswerVerifyRepair: mode === "aggressive",
  };
  const selected = {
    attention: policy.attention,
    activation: policy.activation,
    decoding: policy.decoding,
    attentionCompression: policy.attentionCompression,
    contextBudget,
    canonicalization,
    stateReinforcement,
    retrieval,
    validation,
    multipass,
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
    reasons: mode === "adaptive"
      ? policy.reasons
      : [...new Set([...policy.reasons, `context_mediation_${mode}`])],
  };
  const policyHash = hashPolicy(selected);
  return {
    ...policy,
    mediationMode: mode,
    contextBudget,
    canonicalization,
    stateReinforcement,
    retrieval,
    validation,
    multipass,
    effectiveContextCeilingTokens: selected.effectiveContextCeilingTokens,
    compactionMode: selected.compactionMode,
    strictStreamToolBoundaryValidation,
    applyContextBudgetPolicy,
    applySystemHint,
    applyGovernorBias,
    reasons: selected.reasons,
    policyHash,
    trace: {
      profileId: policy.profileId,
      policyHash,
      reasons: selected.reasons,
    },
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
    attention_compression: profile.attentionCompression,
    context_budget: policy.contextBudget,
    canonicalization: policy.canonicalization,
    state_reinforcement: policy.stateReinforcement,
    retrieval: policy.retrieval,
    validation: policy.validation,
    multipass: policy.multipass,
    declared_context_tokens: profile.declaredContextTokens,
    declared_context_interpretation: policy.contextBudget.interpretation,
    effective_context_ceiling_tokens: policy.effectiveContextCeilingTokens,
    safe_instruction_tokens: policy.safeInstructionTokens,
    safe_tool_output_tokens: policy.safeToolOutputTokens,
    long_tail_retention: profile.traits.longTailRetention,
    tool_calling_reliability: profile.traits.toolCallingReliability,
    long_context_reliability: profile.traits.longContextReliability,
    output_throughput_bias: profile.traits.outputThroughputBias,
    retry_sensitivity: profile.traits.retrySensitivity,
    compaction_sensitivity: profile.traits.compactionSensitivity,
    long_range_retrieval_reliability: profile.traits.longRangeRetrievalReliability,
    exact_needle_recall_reliability: profile.traits.exactNeedleRecallReliability,
    local_coherence: profile.traits.localCoherence,
    duplicate_context_sensitivity: profile.traits.duplicateContextSensitivity,
    stale_context_sensitivity: profile.traits.staleContextSensitivity,
    structured_output_reliability: profile.traits.structuredOutputReliability,
    speculative_boundary_risk: profile.traits.speculativeBoundaryRisk,
    compaction_mode: policy.compactionMode,
    prefer_memory_stitching: policy.preferMemoryStitching,
    prefer_recent_tool_state_replay: policy.preferRecentToolStateReplay,
    prefer_structured_tool_digests: policy.preferStructuredToolDigests,
    prefer_explicit_state_headers: policy.preferExplicitStateHeaders,
    prefer_deterministic_validation: policy.preferDeterministicValidation,
    dense_attention_facade: profile.recommendations.denseAttentionFacade,
    semantic_state_graph: profile.recommendations.semanticStateGraph,
    active_state_header: profile.recommendations.activeStateHeader,
    critical_fact_pins: profile.recommendations.criticalFactPins,
    evidence_manifest: profile.recommendations.evidenceManifest,
    context_dedupe: profile.recommendations.contextDedupe,
    staleness_filtering: profile.recommendations.stalenessFiltering,
    long_range_recall_verification: profile.recommendations.longRangeRecallVerification,
    citation_verification: profile.recommendations.citationVerification,
    multipass_retrieval: profile.recommendations.multipassRetrieval,
    strict_stream_tool_boundary_validation: policy.strictStreamToolBoundaryValidation,
    reasons: policy.reasons,
  };
}

export function buildArchitecturePolicySystemHint(policy: ModelExecutionPolicy): string | null {
  if (!policy.applySystemHint) return null;
  if (
    policy.mediationMode !== "aggressive"
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
  if (policy.contextBudget.interpretation === "storage_with_working_set") {
    lines.push("Treat declared context as addressable storage; keep current state, critical facts, and cited evidence in the active working set.");
  }
  if (policy.retrieval.evidenceManifest) {
    lines.push("When relying on long context, preserve evidence block IDs near the active state and verify quoted or cited references.");
  }
  if (policy.mediationMode === "aggressive") {
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

function headerValue(headers: Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[key];
  if (typeof direct === "string") return direct;
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== lower) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  }
  return undefined;
}

function nestedSynesisString(container: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const synesis = container?.synesis;
  if (!synesis || typeof synesis !== "object" || Array.isArray(synesis)) return undefined;
  const value = (synesis as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function applyArchitectureOverride(
  profile: ModelArchitectureProfile,
  override: ModelArchitectureProfileOverride | null,
): ModelArchitectureProfile {
  if (!override) return profile;
  const attentionCompression = override.attentionCompression
    ? {
        ...profile.attentionCompression,
        ...definedOnly(override.attentionCompression as unknown as Record<string, unknown>),
        risk: {
          ...profile.attentionCompression.risk,
          ...definedOnly((override.attentionCompression as AttentionCompressionProfile).risk as unknown as Record<string, unknown> | undefined),
        },
      }
    : profile.attentionCompression;
  return {
    ...profile,
    ...definedOnly(override),
    attentionCompression,
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
