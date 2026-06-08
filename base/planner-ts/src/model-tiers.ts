import type { AppConfig } from "./config.js";
import {
  getPlannerPublicOfferings,
  getRoleBackendModel,
  getLlmRoute,
  type LlmRoute,
  type PublicPlannerOffering,
} from "./public-model-catalog.js";
import { normalizeProviderExtraBody } from "./llm/extra-body.js";
import type { GenerationParams } from "./state/types.js";

export type ModelTier = "auto" | "pulse" | "core" | "horizon";

export interface TierSettings {
  requestedModel: string;
  responseModel: string;
  tier: ModelTier;
  critiquePasses: number;
  writerMaxTokens: number;
  criticMaxTokens: number;
  /** When set, use this writer role key for admin pricing (e.g. writer-core). */
  registry_writer_role?: string;
  /** When set, writer LLM uses this model id against the planner LLM gateway. */
  resolved_writer_model?: string;
  /** Direct upstream route for writer calls when admin exposes a standalone public offering. */
  resolved_writer_route?: LlmRoute;
  /** Optional Admin-defined generation overrides for public offering writer calls. */
  writer_generation_params?: GenerationParams;
  /** Controlled model-class/version preset used for architecture mediation. */
  model_capability_preset?: string;
}

const TIER_ALIAS: Record<string, ModelTier> = {
  synesis: "auto",
  "synesis auto": "auto",
  "synesis pulse": "pulse",
  "synesis core": "core",
  "synesis horizon": "horizon",
};

const DEFAULT_MODEL_IDS = [
  "Synesis Auto",
  "Synesis Pulse",
  "Synesis Core",
  "Synesis Horizon",
];

function effortToTier(effort: string): ModelTier {
  const e = effort.trim().toLowerCase();
  if (e === "pulse") return "pulse";
  if (e === "horizon") return "horizon";
  if (e === "core") return "core";
  return "auto";
}

export function listModelIds(config: AppConfig): string[] {
  const raw = (config.SYNESIS_PLANNER_TS_MODEL_IDS ?? "").trim();
  const parsed = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const base = parsed.length > 0 ? parsed : [...DEFAULT_MODEL_IDS];
  const seen = new Set(base.map((id) => id.toLowerCase()));
  const out = [...base];
  for (const o of getPlannerPublicOfferings()) {
    const id = o.client_model_id.trim();
    if (!id) continue;
    const low = id.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(id);
  }
  return out;
}

function normalizeTier(model: string): ModelTier {
  const key = model.trim().toLowerCase();
  return TIER_ALIAS[key] ?? "auto";
}

function writerRoleFromOffering(o: PublicPlannerOffering): string {
  const mode = (o.connection_mode ?? "").trim().toLowerCase();
  if (mode === "standalone") {
    const effort = (o.effort_tier ?? "").trim().toLowerCase();
    if (effort === "pulse" || effort === "core" || effort === "horizon") {
      return `writer-${effort}`;
    }
    return "writer";
  }
  const rv = (o.route_via_role ?? "").trim().toLowerCase();
  if (rv === "coder-pulse") return "writer-pulse";
  if (rv === "coder-core") return "writer-core";
  if (rv === "coder-horizon") return "writer-horizon";
  return `writer-${o.effort_tier.trim().toLowerCase()}`;
}

function generationParamsFromOffering(o: PublicPlannerOffering): GenerationParams | undefined {
  const raw = o.generation_params;
  if (!raw || typeof raw !== "object") return undefined;
  const params = raw as Record<string, unknown>;
  const out: GenerationParams = {};
  const numberParam = (key: keyof GenerationParams): number | undefined => {
    const value = params[key];
    const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
    return num != null && Number.isFinite(num) ? num : undefined;
  };
  const maxTokens = numberParam("max_tokens");
  if (maxTokens != null && maxTokens > 0) out.max_tokens = Math.trunc(maxTokens);
  const temperature = numberParam("temperature");
  if (temperature != null && temperature >= 0) out.temperature = temperature;
  const topP = numberParam("top_p");
  if (topP != null && topP >= 0 && topP <= 1) out.top_p = topP;
  const topK = numberParam("top_k");
  if (topK != null && topK >= 0) out.top_k = Math.trunc(topK);
  const minP = numberParam("min_p");
  if (minP != null && minP >= 0 && minP <= 1) out.min_p = minP;
  const presencePenalty = numberParam("presence_penalty");
  if (presencePenalty != null) out.presence_penalty = presencePenalty;
  const frequencyPenalty = numberParam("frequency_penalty");
  if (frequencyPenalty != null) out.frequency_penalty = frequencyPenalty;
  const repetitionPenalty = numberParam("repetition_penalty");
  if (repetitionPenalty != null && repetitionPenalty >= 0) out.repetition_penalty = repetitionPenalty;
  if (typeof params.enable_thinking === "boolean") out.enable_thinking = params.enable_thinking;
  if (typeof params.reasoning_effort === "string" && params.reasoning_effort.trim()) {
    out.reasoning_effort = params.reasoning_effort.trim();
  }
  if (typeof params.stop === "string" || Array.isArray(params.stop)) out.stop = params.stop as string | string[];
  const seed = numberParam("seed");
  if (seed != null) out.seed = Math.trunc(seed);
  if (typeof params.logprobs === "boolean") out.logprobs = params.logprobs;
  const topLogprobs = numberParam("top_logprobs");
  if (topLogprobs != null && topLogprobs >= 0) out.top_logprobs = Math.trunc(topLogprobs);
  const n = numberParam("n");
  if (n != null && n > 0) out.n = Math.trunc(n);
  if (params.logit_bias && typeof params.logit_bias === "object" && !Array.isArray(params.logit_bias)) {
    out.logit_bias = params.logit_bias as Record<string, number>;
  }
  if (Array.isArray(params.tools)) out.tools = params.tools;
  if (
    params.tool_choice === "none"
    || params.tool_choice === "auto"
    || params.tool_choice === "required"
    || (params.tool_choice && typeof params.tool_choice === "object" && !Array.isArray(params.tool_choice))
  ) {
    out.tool_choice = params.tool_choice as GenerationParams["tool_choice"];
  }
  if (typeof params.parallel_tool_calls === "boolean") out.parallel_tool_calls = params.parallel_tool_calls;
  const extraBody = normalizeProviderExtraBody(params.extra_body);
  if (extraBody) {
    out.extra_body = extraBody;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function modelCapabilityPresetFromOffering(o: PublicPlannerOffering): string | undefined {
  const raw = o.generation_params;
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>).model_capability_preset;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveTierSettings(requestModel: string | null | undefined): TierSettings {
  const requestedModel = (requestModel ?? "").trim();
  const reqLow = requestedModel.toLowerCase();

  for (const o of getPlannerPublicOfferings()) {
    if (o.client_model_id.trim().toLowerCase() !== reqLow) continue;
    const tier = effortToTier(o.effort_tier);
    const writerRole = writerRoleFromOffering(o);
    const mode = (o.connection_mode ?? "").trim().toLowerCase();
    const registryModel = mode === "standalone"
      ? ((o.backend_model_override ?? "").trim() || o.client_model_id.trim() || requestedModel)
      : ((o.backend_model_override ?? "").trim() || getRoleBackendModel(writerRole));
    const writerRoute = mode === "standalone" ? getLlmRoute(o.client_model_id) : getLlmRoute(writerRole);
    const writerGenerationParams = generationParamsFromOffering(o);
    const modelCapabilityPreset = modelCapabilityPresetFromOffering(o);
    if (tier === "pulse") {
      return {
        requestedModel,
        responseModel: o.label?.trim() || requestedModel,
        tier: "pulse",
        critiquePasses: 1,
        writerMaxTokens: 8192,
        criticMaxTokens: 4096,
        registry_writer_role: writerRole,
        resolved_writer_model: registryModel,
        resolved_writer_route: writerRoute,
        writer_generation_params: writerGenerationParams,
        model_capability_preset: modelCapabilityPreset,
      };
    }
    if (tier === "horizon") {
      return {
        requestedModel,
        responseModel: o.label?.trim() || requestedModel,
        tier: "horizon",
        critiquePasses: 3,
        writerMaxTokens: 32768,
        criticMaxTokens: 4096,
        registry_writer_role: writerRole,
        resolved_writer_model: registryModel,
        resolved_writer_route: writerRoute,
        writer_generation_params: writerGenerationParams,
        model_capability_preset: modelCapabilityPreset,
      };
    }
    if (tier === "core") {
      return {
        requestedModel,
        responseModel: o.label?.trim() || requestedModel,
        tier: "core",
        critiquePasses: 2,
        writerMaxTokens: 16384,
        criticMaxTokens: 4096,
        registry_writer_role: writerRole,
        resolved_writer_model: registryModel,
        resolved_writer_route: writerRoute,
        writer_generation_params: writerGenerationParams,
        model_capability_preset: modelCapabilityPreset,
      };
    }
    return {
      requestedModel,
      responseModel: o.label?.trim() || requestedModel,
      tier: "auto",
      critiquePasses: 2,
      writerMaxTokens: 32768,
      criticMaxTokens: 4096,
      registry_writer_role: "writer",
      resolved_writer_model: registryModel,
      resolved_writer_route: writerRoute,
      writer_generation_params: writerGenerationParams,
      model_capability_preset: modelCapabilityPreset,
    };
  }

  const tier = normalizeTier(requestedModel);

  if (tier === "pulse") {
    return {
      requestedModel,
      responseModel: "Synesis Pulse",
      tier,
      critiquePasses: 1,
      writerMaxTokens: 8192,
      criticMaxTokens: 4096,
      registry_writer_role: "writer-pulse",
    };
  }

  if (tier === "horizon") {
    return {
      requestedModel,
      responseModel: "Synesis Horizon",
      tier,
      critiquePasses: 3,
      writerMaxTokens: 32768,
      criticMaxTokens: 4096,
      registry_writer_role: "writer-horizon",
    };
  }

  if (tier === "core") {
    return {
      requestedModel,
      responseModel: "Synesis Core",
      tier,
      critiquePasses: 2,
      writerMaxTokens: 16384,
      criticMaxTokens: 4096,
      registry_writer_role: "writer-core",
    };
  }

  return {
    requestedModel,
    responseModel: "Synesis Auto",
    tier: "auto",
    critiquePasses: 2,
    writerMaxTokens: 32768,
    criticMaxTokens: 4096,
    registry_writer_role: "writer",
  };
}
