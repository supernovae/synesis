export const CAPABILITY_MATRIX_VERSION = 1;

export const KNOWN_CAPABILITY_KEYS = [
  "yarn.reducers_enabled",
  "yarn.transcript_prune_enabled",
  "yarn.phase_execution_policy_enabled",
  "yarn.json_compaction_enabled",
  "yarn.content_dedupe_enabled",
  "yarn.response_dedupe_enabled",
  "yarn.historical_normalize_enabled",
  "planner.context_optimizer_enabled",
  "webui.builtin_tools_enabled",
  "webui.file_context_enabled",
] as const;

export type CapabilityKey = (typeof KNOWN_CAPABILITY_KEYS)[number];
export type CapabilityMatrixMode = "enforced" | "shadow";
export type CapabilitySelectorType = "exact_model" | "model_path_prefix" | "family_prefix";

export interface CapabilityMatrixOverride {
  id: string;
  enabled?: boolean;
  selector_type: CapabilitySelectorType;
  selector: string;
  priority?: number;
  capabilities: Record<string, boolean>;
}

export interface CapabilityMatrixDocument {
  version?: number;
  mode?: CapabilityMatrixMode;
  global_optimizations_enabled?: boolean;
  overrides?: CapabilityMatrixOverride[];
}

export interface CapabilityMatrixInput {
  model_id: string;
  model_path?: string;
  family?: string;
}

export interface MatchedSelector {
  id: string;
  selector_type: CapabilitySelectorType;
  selector: string;
  priority: number;
}

export interface CapabilityMatrixResolution {
  mode: CapabilityMatrixMode;
  global_optimizations_enabled: boolean;
  resolved_capabilities: Record<CapabilityKey, boolean>;
  matched_override_ids: string[];
  matched_selectors: MatchedSelector[];
}

function normalizeString(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function rankSelectorType(selectorType: CapabilitySelectorType): number {
  if (selectorType === "family_prefix") return 1;
  if (selectorType === "model_path_prefix") return 2;
  return 3;
}

function buildDefaultResolved(globalEnabled: boolean): Record<CapabilityKey, boolean> {
  const resolved = {} as Record<CapabilityKey, boolean>;
  for (const key of KNOWN_CAPABILITY_KEYS) {
    resolved[key] = globalEnabled;
  }
  return resolved;
}

function matchesSelector(override: CapabilityMatrixOverride, input: CapabilityMatrixInput): boolean {
  const selector = normalizeString(override.selector);
  if (!selector) return false;
  if (override.selector_type === "exact_model") {
    return normalizeString(input.model_id) === selector;
  }
  if (override.selector_type === "model_path_prefix") {
    const modelPath = normalizeString(input.model_path);
    return modelPath.length > 0 && modelPath.startsWith(selector);
  }
  const family = normalizeString(input.family);
  return family.length > 0 && family.startsWith(selector);
}

function normalizeOverrides(doc: CapabilityMatrixDocument): CapabilityMatrixOverride[] {
  return (doc.overrides ?? [])
    .filter((row) =>
      Boolean(row)
      && typeof row.id === "string"
      && typeof row.selector === "string"
      && typeof row.selector_type === "string"
      && typeof row.capabilities === "object"
      && row.capabilities !== null,
    )
    .filter((row) =>
      row.selector_type === "exact_model"
      || row.selector_type === "model_path_prefix"
      || row.selector_type === "family_prefix",
    )
    .filter((row) => row.enabled !== false);
}

export function resolveCapabilityMatrix(
  matrix: CapabilityMatrixDocument | null | undefined,
  input: CapabilityMatrixInput,
): CapabilityMatrixResolution {
  const mode = matrix?.mode === "shadow" ? "shadow" : "enforced";
  const globalEnabled = matrix?.global_optimizations_enabled === true;
  const resolved = buildDefaultResolved(globalEnabled);

  const matches = normalizeOverrides(matrix ?? {})
    .filter((row) => matchesSelector(row, input))
    .sort((a, b) => {
      const rankDiff = rankSelectorType(a.selector_type) - rankSelectorType(b.selector_type);
      if (rankDiff !== 0) return rankDiff;
      const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      return String(a.id).localeCompare(String(b.id));
    });

  for (const row of matches) {
    for (const [rawKey, value] of Object.entries(row.capabilities ?? {})) {
      if (!KNOWN_CAPABILITY_KEYS.includes(rawKey as CapabilityKey)) continue;
      if (typeof value !== "boolean") continue;
      resolved[rawKey as CapabilityKey] = value;
    }
  }

  return {
    mode,
    global_optimizations_enabled: globalEnabled,
    resolved_capabilities: resolved,
    matched_override_ids: matches.map((m) => m.id),
    matched_selectors: matches.map((m) => ({
      id: m.id,
      selector_type: m.selector_type,
      selector: m.selector,
      priority: m.priority ?? 0,
    })),
  };
}
