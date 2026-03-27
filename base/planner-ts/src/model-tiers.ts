import type { AppConfig } from "./config.js";

export type ModelTier = "auto" | "pulse" | "core" | "horizon";

export interface TierSettings {
  requestedModel: string;
  responseModel: string;
  tier: ModelTier;
  critiquePasses: number;
  writerMaxTokens: number;
  criticMaxTokens: number;
}

const TIER_ALIAS: Record<string, ModelTier> = {
  "synesis": "auto",
  "synesis auto": "auto",
  "synesis pulse": "pulse",
  "synesis core": "core",
  "synesis horizon": "horizon"
};

const DEFAULT_MODEL_IDS = [
  "Synesis Auto",
  "Synesis Pulse",
  "Synesis Core",
  "Synesis Horizon"
];

export function listModelIds(config: AppConfig): string[] {
  const raw = (config.SYNESIS_PLANNER_TS_MODEL_IDS ?? "").trim();
  const parsed = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_MODEL_IDS;
}

function normalizeTier(model: string): ModelTier {
  const key = model.trim().toLowerCase();
  return TIER_ALIAS[key] ?? "auto";
}

export function resolveTierSettings(requestModel: string | null | undefined): TierSettings {
  const requestedModel = (requestModel ?? "").trim();
  const tier = normalizeTier(requestedModel);

  if (tier === "pulse") {
    return {
      requestedModel,
      responseModel: "Synesis Pulse",
      tier,
      critiquePasses: 1,
      writerMaxTokens: 1000,
      criticMaxTokens: 700
    };
  }

  if (tier === "horizon") {
    return {
      requestedModel,
      responseModel: "Synesis Horizon",
      tier,
      critiquePasses: 3,
      writerMaxTokens: 2600,
      criticMaxTokens: 1600
    };
  }

  if (tier === "core") {
    return {
      requestedModel,
      responseModel: "Synesis Core",
      tier,
      critiquePasses: 2,
      writerMaxTokens: 1800,
      criticMaxTokens: 1200
    };
  }

  return {
    requestedModel,
    responseModel: "Synesis Auto",
    tier: "auto",
    critiquePasses: 2,
    writerMaxTokens: 1800,
    criticMaxTokens: 1200
  };
}
