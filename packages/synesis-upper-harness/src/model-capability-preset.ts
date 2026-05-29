export const MODEL_CAPABILITY_PRESET_IDS = [
  "generic_openai_compatible",
  "deepseek_v3",
  "deepseek_v4",
  "qwen_3",
  "qwen_3_coder",
  "kimi_k2",
  "glm_4_5",
  "minimax_m1",
  "minimax_m2",
  "xiaomi_mimo_2",
  "xiaomi_mimo_2_5",
] as const;

export type ModelCapabilityPresetId = typeof MODEL_CAPABILITY_PRESET_IDS[number];

const MODEL_CAPABILITY_PRESET_SET = new Set<string>(MODEL_CAPABILITY_PRESET_IDS);

const MODEL_CAPABILITY_ALIASES: Record<string, ModelCapabilityPresetId> = {
  generic: "generic_openai_compatible",
  generic_openai: "generic_openai_compatible",
  openai_compatible: "generic_openai_compatible",
  deepseek: "deepseek_v4",
  deepseek_v3_0324: "deepseek_v3",
  deepseek_v4_pro: "deepseek_v4",
  deepseek_v4_flash: "deepseek_v4",
  qwen: "qwen_3",
  qwen3: "qwen_3",
  qwen3_coder: "qwen_3_coder",
  qwen_coder: "qwen_3_coder",
  kimi: "kimi_k2",
  kimi_k2_5: "kimi_k2",
  kimi_k2_6: "kimi_k2",
  moonshot_kimi_k2: "kimi_k2",
  glm: "glm_4_5",
  glm_45: "glm_4_5",
  glm_4_5_air: "glm_4_5",
  minimax: "minimax_m2",
  abab: "minimax_m2",
  xiaomi: "xiaomi_mimo_2_5",
  mimo: "xiaomi_mimo_2_5",
  mimo_2: "xiaomi_mimo_2",
  mimo_v2: "xiaomi_mimo_2",
  mimo_2_5: "xiaomi_mimo_2_5",
  mimo_v2_5: "xiaomi_mimo_2_5",
};

export function normalizeModelCapabilityPreset(value: unknown): ModelCapabilityPresetId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[:./\s-]+/g, "_").replace(/_+/g, "_");
  if (!normalized) return undefined;
  if (MODEL_CAPABILITY_PRESET_SET.has(normalized)) return normalized as ModelCapabilityPresetId;
  return MODEL_CAPABILITY_ALIASES[normalized];
}

export function inferModelCapabilityPreset(
  modelId: string,
  family?: string | null,
): ModelCapabilityPresetId | undefined {
  const model = (modelId ?? "").toLowerCase();
  const fam = (family ?? "").toLowerCase();
  if (/deepseek/.test(model) || fam === "deepseek") {
    return /v3|r1/.test(model) ? "deepseek_v3" : "deepseek_v4";
  }
  if (/qwen3.*coder|qwen.*coder/.test(model) || fam === "qwen3-coder") return "qwen_3_coder";
  if (/qwen/.test(model)) return "qwen_3";
  if (/kimi|moonshot|k2[.-]?[56]/.test(model) || fam === "kimi") return "kimi_k2";
  if (/glm[-_. ]?4[-_. ]?5|glm[-_. ]?45/.test(model) || fam === "glm") return "glm_4_5";
  if (/minimax|abab/.test(model) || fam === "minimax") {
    return /m1|1\.1/.test(model) ? "minimax_m1" : "minimax_m2";
  }
  if (/xiaomi|mimo/.test(model) || fam === "xiaomi") {
    return /v?2(?![._-]?5)|flash/.test(model) ? "xiaomi_mimo_2" : "xiaomi_mimo_2_5";
  }
  return undefined;
}

export function adapterHintForModelCapabilityPreset(
  preset: ModelCapabilityPresetId | string | null | undefined,
): string | undefined {
  const normalized = normalizeModelCapabilityPreset(preset);
  switch (normalized) {
    case "deepseek_v3":
    case "deepseek_v4":
      return "deepseek";
    case "qwen_3_coder":
      return "qwen3-coder";
    case "kimi_k2":
      return "kimi";
    case "minimax_m1":
    case "minimax_m2":
      return "minimax";
    case "xiaomi_mimo_2":
    case "xiaomi_mimo_2_5":
      return "xiaomi";
    default:
      return undefined;
  }
}

export function telemetryProviderForModelCapabilityPreset(
  preset: ModelCapabilityPresetId | string | null | undefined,
): string | undefined {
  const normalized = normalizeModelCapabilityPreset(preset);
  switch (normalized) {
    case "deepseek_v3":
    case "deepseek_v4":
      return "deepseek";
    default:
      return undefined;
  }
}
