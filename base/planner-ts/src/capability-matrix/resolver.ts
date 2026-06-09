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

const MATRIX_ID_LIMIT = 128;
const MATRIX_SELECTOR_LIMIT = 256;
const MATRIX_PRIORITY_MIN = -1000;
const MATRIX_PRIORITY_MAX = 1000;
const CAPABILITY_KEY_SET = new Set<string>(KNOWN_CAPABILITY_KEYS);

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}

function safeMatrixText(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string"
    && typeof value !== "number"
    && typeof value !== "boolean"
  ) {
    return "";
  }
  return replaceControlCharsWithSpace(String(value))
    .replace(/[<>"`=]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function safeMatrixId(value: unknown): string {
  return safeMatrixText(value, MATRIX_ID_LIMIT)
    .toLowerCase()
    .replace(/[^a-z0-9_.@/+:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSelectorType(value: unknown): CapabilitySelectorType | null {
  const selectorType = safeMatrixText(value, 32).toLowerCase();
  if (
    selectorType === "exact_model"
    || selectorType === "model_path_prefix"
    || selectorType === "family_prefix"
  ) {
    return selectorType;
  }
  return null;
}

function normalizePriority(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(
    MATRIX_PRIORITY_MIN,
    Math.min(MATRIX_PRIORITY_MAX, Math.trunc(numeric)),
  );
}

function normalizeCapabilities(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const capabilities: Record<string, boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!CAPABILITY_KEY_SET.has(rawKey)) continue;
    if (typeof rawValue !== "boolean") continue;
    capabilities[rawKey] = rawValue;
  }
  return capabilities;
}

function normalizeString(value: string | undefined): string {
  return safeMatrixText(value, MATRIX_SELECTOR_LIMIT).toLowerCase();
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
  const rows = Array.isArray(doc.overrides) ? (doc.overrides as unknown[]) : [];
  const normalized: CapabilityMatrixOverride[] = [];
  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) continue;
    const row = rawRow as Record<string, unknown>;
    if (row.enabled === false) continue;

    const id = safeMatrixId(row.id);
    const selectorType = normalizeSelectorType(row.selector_type);
    const selector = safeMatrixText(row.selector, MATRIX_SELECTOR_LIMIT).toLowerCase();
    const capabilities = normalizeCapabilities(row.capabilities);
    if (!id || !selectorType || !selector || Object.keys(capabilities).length === 0) continue;

    normalized.push({
      id,
      selector_type: selectorType,
      selector,
      priority: normalizePriority(row.priority),
      capabilities,
    });
  }
  return normalized;
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
