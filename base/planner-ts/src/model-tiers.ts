import type { AppConfig } from "./config.js";
import { getPlannerPublicOfferings, getRoleBackendModel } from "./public-model-catalog.js";

export type ModelTier = "auto" | "pulse" | "core" | "horizon";

export interface TierSettings {
  requestedModel: string;
  responseModel: string;
  tier: ModelTier;
  critiquePasses: number;
  writerMaxTokens: number;
  criticMaxTokens: number;
  /** When set, use this role key for admin pricing (e.g. general-core). */
  registry_general_role?: string;
  /** When set, writer LLM uses this model id against the planner LLM gateway. */
  resolved_writer_model?: string;
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

export function resolveTierSettings(requestModel: string | null | undefined): TierSettings {
  const requestedModel = (requestModel ?? "").trim();
  const reqLow = requestedModel.toLowerCase();

  for (const o of getPlannerPublicOfferings()) {
    if (o.client_model_id.trim().toLowerCase() !== reqLow) continue;
    const tier = effortToTier(o.effort_tier);
    const generalRole = `general-${o.effort_tier.trim().toLowerCase()}`;
    const registryModel =
      (o.backend_model_override ?? "").trim() || getRoleBackendModel(generalRole);
    if (tier === "pulse") {
      return {
        requestedModel,
        responseModel: o.label?.trim() || requestedModel,
        tier: "pulse",
        critiquePasses: 1,
        writerMaxTokens: 8192,
        criticMaxTokens: 4096,
        registry_general_role: generalRole,
        resolved_writer_model: registryModel,
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
        registry_general_role: generalRole,
        resolved_writer_model: registryModel,
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
        registry_general_role: generalRole,
        resolved_writer_model: registryModel,
      };
    }
    return {
      requestedModel,
      responseModel: o.label?.trim() || requestedModel,
      tier: "auto",
      critiquePasses: 2,
      writerMaxTokens: 32768,
      criticMaxTokens: 4096,
      registry_general_role: "general",
      resolved_writer_model: registryModel,
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
      registry_general_role: "general-pulse",
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
      registry_general_role: "general-horizon",
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
      registry_general_role: "general-core",
    };
  }

  return {
    requestedModel,
    responseModel: "Synesis Auto",
    tier: "auto",
    critiquePasses: 2,
    writerMaxTokens: 32768,
    criticMaxTokens: 4096,
    registry_general_role: "general",
  };
}
