import { useEffect, useMemo, useState } from "react";
import {
  useCapabilityMatrix,
  useCreateCapabilityMatrixOverride,
  useDeleteCapabilityMatrixOverride,
  useProviderGovernance,
  useRoleAssignments,
  useUpdateCapabilityMatrixGlobal,
  useUpdateCapabilityMatrixOverride,
  useYarnRuntimeTelemetry,
} from "../../api/hooks";
import type {
  CapabilityMatrixEffective,
  CapabilityMatrixOverride,
  CapabilitySelectorType,
  ModelDeployment,
} from "../../types";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import StatusBadge from "../../components/common/StatusBadge";

const SELECTOR_TYPES: CapabilitySelectorType[] = ["family_prefix", "model_path_prefix", "exact_model"];

const SELECTOR_LABELS: Record<CapabilitySelectorType, string> = {
  family_prefix: "Family prefix",
  model_path_prefix: "Model path prefix",
  exact_model: "Exact model",
};

const CAPABILITY_LABELS: Record<string, string> = {
  "yarn.reducers_enabled": "Yarn reducers",
  "yarn.transcript_prune_enabled": "Yarn transcript prune",
  "yarn.phase_execution_policy_enabled": "Yarn phase policy",
  "yarn.json_compaction_enabled": "Yarn JSON compaction",
  "yarn.content_dedupe_enabled": "Yarn content dedupe",
  "yarn.response_dedupe_enabled": "Yarn response dedupe",
  "yarn.historical_normalize_enabled": "Yarn historical normalize",
  "planner.context_optimizer_enabled": "Planner context optimizer",
  "webui.builtin_tools_enabled": "WebUI builtin tools",
  "webui.file_context_enabled": "WebUI file context",
};

interface SelectorChoice {
  value: string;
  label: string;
  source: "registry" | "existing_override";
}

type SelectorChoiceCatalog = Record<CapabilitySelectorType, SelectorChoice[]>;

interface RegistryCapabilityRow {
  role: string;
  provider: string;
  modelId: string;
  modelPath: string;
  family: string;
  matchedLabels: string[];
  resolved: Record<string, boolean>;
  providerEnabled: boolean | null;
  providerNeedsKey: boolean;
  providerKeyConfigured: boolean | null;
}

interface LegacySelectorFixCandidate {
  row: CapabilityMatrixOverride;
  suggestions: SelectorChoice[];
  suggestedSelector: string | null;
  reason: string;
}

function inferCapabilityFamily(modelRef: string): string {
  const normalized = modelRef.toLowerCase();
  if (/qwen3.*coder/.test(normalized)) return "qwen3-coder";
  if (/deepseek/.test(normalized)) return "deepseek";
  if (/kimi|moonshot/.test(normalized)) return "kimi";
  if (/minimax|abab/.test(normalized)) return "minimax";
  return "generic";
}

function addSelectorChoice(
  target: Map<string, { contexts: Set<string>; source: SelectorChoice["source"] }>,
  rawValue: string,
  context: string,
  source: SelectorChoice["source"],
): void {
  const value = rawValue.trim();
  if (!value) return;
  const existing = target.get(value);
  if (existing) {
    existing.contexts.add(context);
    if (source === "registry") existing.source = "registry";
    return;
  }
  target.set(value, {
    contexts: new Set([context]),
    source,
  });
}

function contextSummary(contexts: Set<string>): string {
  const values = [...contexts].sort((a, b) => a.localeCompare(b));
  if (values.length <= 2) return values.join(", ");
  return `${values.slice(0, 2).join(", ")} +${values.length - 2} more`;
}

function toSelectorChoices(
  source: Map<string, { contexts: Set<string>; source: SelectorChoice["source"] }>,
): SelectorChoice[] {
  return [...source.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, metadata]) => ({
      value,
      source: metadata.source,
      label:
        metadata.source === "existing_override"
          ? `${value} (existing override)`
          : `${value} (${contextSummary(metadata.contexts)})`,
    }));
}

function buildSelectorCatalog(
  deployments: ModelDeployment[],
  overrides: CapabilityMatrixOverride[],
): SelectorChoiceCatalog {
  const exactModel = new Map<string, { contexts: Set<string>; source: SelectorChoice["source"] }>();
  const modelPath = new Map<string, { contexts: Set<string>; source: SelectorChoice["source"] }>();
  const familyPrefix = new Map<string, { contexts: Set<string>; source: SelectorChoice["source"] }>();

  for (const deployment of deployments) {
    const roleLabel = `${deployment.role}/${deployment.provider || "unknown-provider"}`;
    const served = deployment.served_name.trim();
    const backendModel = deployment.model.trim();
    const modelRef = backendModel || served;

    if (served) {
      addSelectorChoice(exactModel, served, `${roleLabel} served-name`, "registry");
    }
    if (backendModel) {
      addSelectorChoice(exactModel, backendModel, `${roleLabel} backend-model`, "registry");
      addSelectorChoice(modelPath, backendModel, `${roleLabel} backend-model`, "registry");
    }
    if (modelRef) {
      addSelectorChoice(
        familyPrefix,
        inferCapabilityFamily(modelRef),
        `${roleLabel} inferred-family`,
        "registry",
      );
    }
  }

  for (const row of overrides) {
    if (row.selector_type === "exact_model") {
      addSelectorChoice(exactModel, row.selector, "existing override", "existing_override");
      continue;
    }
    if (row.selector_type === "model_path_prefix") {
      addSelectorChoice(modelPath, row.selector, "existing override", "existing_override");
      continue;
    }
    addSelectorChoice(familyPrefix, row.selector, "existing override", "existing_override");
  }

  return {
    exact_model: toSelectorChoices(exactModel),
    model_path_prefix: toSelectorChoices(modelPath),
    family_prefix: toSelectorChoices(familyPrefix),
  };
}

function isCanonicalSelector(
  catalog: SelectorChoiceCatalog,
  selectorType: CapabilitySelectorType,
  selector: string,
): boolean {
  const target = selector.trim();
  if (!target) return false;
  return catalog[selectorType].some((choice) => choice.value === target);
}

function chooseCanonicalSelectorValue(
  choices: SelectorChoice[],
  selectorType: CapabilitySelectorType,
  selector: string,
): string | null {
  if (choices.length === 0) return null;
  const raw = selector.trim();
  const fallback = choices[0]?.value ?? null;
  if (!raw) return fallback;
  const exact = choices.find((choice) => choice.value === raw);
  if (exact) return exact.value;

  const normalizedRaw = normalizeSelector(raw);
  const normalizedMatch = choices.find((choice) => normalizeSelector(choice.value) === normalizedRaw);
  if (normalizedMatch) return normalizedMatch.value;

  if (selectorType !== "exact_model") {
    const prefixMatches = choices.filter((choice) => {
      const normalizedChoice = normalizeSelector(choice.value);
      return normalizedChoice.startsWith(normalizedRaw) || normalizedRaw.startsWith(normalizedChoice);
    });
    if (prefixMatches.length === 1) return prefixMatches[0]?.value ?? fallback;
  }

  return fallback;
}

interface CapabilityPreset {
  id: string;
  title: string;
  description: string;
  priority: number;
  capabilities: Record<string, boolean>;
}

const RECOMMENDED_PRESETS: CapabilityPreset[] = [
  {
    id: "qwen-diagnostics-mode",
    title: "Qwen diagnostics mode",
    description: "Phase guard only, with all other matrix capabilities off for cleaner trace capture and A/B debugging.",
    priority: 90,
    capabilities: {
      "yarn.phase_execution_policy_enabled": true,
    },
  },
  {
    id: "qwen-safe-baseline",
    title: "Qwen safe baseline",
    description: "Enable only the phase policy guard. Keep all context-shaping optimizations off.",
    priority: 100,
    capabilities: {
      "yarn.phase_execution_policy_enabled": true,
    },
  },
  {
    id: "qwen-step2-prune",
    title: "Qwen step 2 - add prune",
    description: "Keep phase guard on and enable transcript pruning. Useful after stable baseline runs.",
    priority: 110,
    capabilities: {
      "yarn.phase_execution_policy_enabled": true,
      "yarn.transcript_prune_enabled": true,
    },
  },
  {
    id: "qwen-step3-reducers",
    title: "Qwen step 3 - add reducers",
    description: "Enable reducers after prune has proven stable, while keeping dedupe/normalize controls conservative.",
    priority: 120,
    capabilities: {
      "yarn.phase_execution_policy_enabled": true,
      "yarn.transcript_prune_enabled": true,
      "yarn.reducers_enabled": true,
    },
  },
];

function selectorRank(selectorType: CapabilitySelectorType): number {
  if (selectorType === "family_prefix") return 1;
  if (selectorType === "model_path_prefix") return 2;
  return 3;
}

interface PreviewMatch {
  id: string;
  name: string;
  selectorType: CapabilitySelectorType;
  selector: string;
  enabled: boolean;
  matched: boolean;
  comparedFieldLabel: string;
  comparedValue: string;
}

function resolvePreview(matrix: CapabilityMatrixEffective, input: { modelId: string; family: string; modelPath: string }) {
  const base = Object.fromEntries(
    matrix.supported_capabilities.map((capability) => [capability, matrix.global_optimizations_enabled]),
  ) as Record<string, boolean>;

  const normalizedModel = input.modelId.trim().toLowerCase();
  const normalizedFamily = input.family.trim().toLowerCase();
  const normalizedPath = input.modelPath.trim().toLowerCase();

  const evaluations: PreviewMatch[] = [...matrix.overrides]
    .map((row) => {
      const selector = row.selector.trim().toLowerCase();
      const comparedFieldLabel = row.selector_type === "exact_model"
        ? "Model ID"
        : row.selector_type === "model_path_prefix"
          ? "Model path"
          : "Family";
      const comparedValue = row.selector_type === "exact_model"
        ? normalizedModel
        : row.selector_type === "model_path_prefix"
          ? normalizedPath
          : normalizedFamily;
      const matched = row.enabled
        && selector.length > 0
        && (row.selector_type === "exact_model"
          ? comparedValue === selector
          : comparedValue.length > 0 && comparedValue.startsWith(selector));
      return {
        id: row.id,
        name: row.name,
        selectorType: row.selector_type,
        selector: row.selector,
        enabled: row.enabled,
        matched,
        comparedFieldLabel,
        comparedValue,
      };
    })
    .sort((a, b) => {
      const rank = selectorRank(a.selectorType) - selectorRank(b.selectorType);
      if (rank !== 0) return rank;
      return a.id.localeCompare(b.id);
    });
  const matchedIds = new Set(evaluations.filter((row) => row.matched).map((row) => row.id));
  const matches = [...matrix.overrides]
    .filter((row) => matchedIds.has(row.id))
    .sort((a, b) => {
      const rank = selectorRank(a.selector_type) - selectorRank(b.selector_type);
      if (rank !== 0) return rank;
      const priority = a.priority - b.priority;
      if (priority !== 0) return priority;
      return a.id.localeCompare(b.id);
    });

  for (const row of matches) {
    for (const [key, value] of Object.entries(row.capabilities)) {
      if (!(key in base)) continue;
      if (typeof value !== "boolean") continue;
      base[key] = value;
    }
  }

  return {
    resolved: base,
    matchedIds: matches.map((row) => row.id),
    matchedLabels: matches.map((row) => row.name.trim() || row.id),
    evaluations,
  };
}

function capabilitySummary(row: CapabilityMatrixOverride): string {
  const enabled = Object.entries(row.capabilities)
    .filter(([, value]) => value)
    .map(([key]) => CAPABILITY_LABELS[key] ?? key);
  if (enabled.length === 0) return "No capabilities enabled";
  return enabled.join(", ");
}

function normalizeSelector(value: string): string {
  return value.trim().toLowerCase();
}

function materializePresetCapabilities(
  supportedCapabilities: string[],
  presetCapabilities: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const key of supportedCapabilities) {
    next[key] = false;
  }
  for (const [key, value] of Object.entries(presetCapabilities)) {
    if (!(key in next)) continue;
    next[key] = value;
  }
  return next;
}

function selectorFromPreview(
  selectorType: CapabilitySelectorType,
  preview: { modelId: string; family: string; modelPath: string },
): string {
  if (selectorType === "exact_model") return preview.modelId.trim();
  if (selectorType === "family_prefix") return preview.family.trim();
  return preview.modelPath.trim();
}

export default function CapabilityMatrixPage() {
  const { data, isLoading, error } = useCapabilityMatrix();
  const { data: roleAssignments } = useRoleAssignments();
  const { data: providerGovernance } = useProviderGovernance();
  const {
    data: runtimeTelemetry,
    isLoading: runtimeTelemetryLoading,
    error: runtimeTelemetryError,
  } = useYarnRuntimeTelemetry();
  const updateGlobal = useUpdateCapabilityMatrixGlobal();
  const createOverride = useCreateCapabilityMatrixOverride();
  const updateOverride = useUpdateCapabilityMatrixOverride();
  const deleteOverride = useDeleteCapabilityMatrixOverride();

  const [previewModelId, setPreviewModelId] = useState("");
  const [previewFamily, setPreviewFamily] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [formSelectorType, setFormSelectorType] = useState<CapabilitySelectorType>("exact_model");
  const [formSelector, setFormSelector] = useState("");
  const [formPriority, setFormPriority] = useState(0);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formCapabilities, setFormCapabilities] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string>("");
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [globalMode, setGlobalMode] = useState<CapabilityMatrixEffective["mode"]>("enforced");
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [presetSelectorType, setPresetSelectorType] = useState<CapabilitySelectorType>("exact_model");
  const [presetSelector, setPresetSelector] = useState("");
  const [presetApplyGlobalOff, setPresetApplyGlobalOff] = useState(true);
  const [presetError, setPresetError] = useState("");
  const [presetStatus, setPresetStatus] = useState("");
  const [legacyFixSelections, setLegacyFixSelections] = useState<Record<string, string>>({});
  const [legacyFixError, setLegacyFixError] = useState("");
  const [legacyFixStatus, setLegacyFixStatus] = useState("");

  const supportedCapabilities = data?.supported_capabilities ?? [];
  const assignedDeployments = useMemo(
    () => (roleAssignments?.roles ?? []).filter((row) => row.assigned),
    [roleAssignments?.roles],
  );
  const registrySelectorCatalog = useMemo(
    () => buildSelectorCatalog(assignedDeployments, []),
    [assignedDeployments],
  );
  const selectorCatalog = useMemo(
    () => buildSelectorCatalog(assignedDeployments, data?.overrides ?? []),
    [assignedDeployments, data?.overrides],
  );
  const formSelectorChoices = registrySelectorCatalog[formSelectorType];
  const presetSelectorChoices = registrySelectorCatalog[presetSelectorType];
  const previewModelChoices = selectorCatalog.exact_model;
  const previewFamilyChoices = selectorCatalog.family_prefix;
  const previewPathChoices = selectorCatalog.model_path_prefix;
  const formSelectorIsCanonical = isCanonicalSelector(
    registrySelectorCatalog,
    formSelectorType,
    formSelector,
  );
  const presetSelectorIsCanonical = isCanonicalSelector(
    registrySelectorCatalog,
    presetSelectorType,
    presetSelector,
  );
  const providerStatusByKey = useMemo(() => {
    const map = new Map<
      string,
      { enabled: boolean; apiKeyConfigured: boolean | null; apiKeyEnv: string; isLocal: boolean }
    >();
    for (const provider of providerGovernance?.providers ?? []) {
      map.set(provider.key, {
        enabled: provider.enabled,
        apiKeyConfigured: provider.api_key_configured ?? null,
        apiKeyEnv: provider.api_key_env ?? "",
        isLocal: provider.is_local,
      });
    }
    return map;
  }, [providerGovernance?.providers]);
  const runtimeGovernanceStatus = useMemo<{
    status: "ok" | "warning" | "error" | "pending";
    label: string;
    detail: string;
    metrics: Array<{ label: string; value: string }>;
  }>(() => {
    if (runtimeTelemetryLoading) {
      return {
        status: "pending",
        label: "Checking runtime",
        detail: "Querying live Yarn telemetry to confirm capability-matrix enforcement is active.",
        metrics: [{ label: "Telemetry", value: "Loading..." }],
      };
    }
    if (runtimeTelemetryError) {
      return {
        status: "warning",
        label: "Telemetry unavailable",
        detail: "Could not verify runtime enforcement. Capability matrix may be configured but not currently active in Yarn.",
        metrics: [{ label: "Telemetry", value: "Unavailable" }],
      };
    }
    const governanceFlag = runtimeTelemetry?.featureFlags?.governance === true;
    const governanceBypass = runtimeTelemetry?.featureFlags?.governanceBypass === true;
    const governanceStats = runtimeTelemetry?.governance;
    const lastFetchedAt =
      governanceStats?.lastFetchedAt && governanceStats.lastFetchedAt > 0
        ? new Date(governanceStats.lastFetchedAt).toLocaleString()
        : "—";
    const baseMetrics = [
      { label: "Feature flag", value: governanceFlag ? "ON" : "OFF" },
      { label: "Bypass flag", value: governanceBypass ? "ON" : "OFF" },
      { label: "Poll updates", value: String(governanceStats?.updates ?? 0) },
      { label: "Rules loaded", value: String(governanceStats?.rulesLoaded ?? 0) },
      { label: "Poll errors", value: String(governanceStats?.errors ?? 0) },
      { label: "Last fetch", value: lastFetchedAt },
    ];
    if (!governanceFlag) {
      return {
        status: "error",
        label: "Disabled in Yarn runtime",
        detail:
          "SYNESIS_YARN_GOVERNANCE_ENABLED is OFF on the running Yarn pod. Capability overrides will not be enforced.",
        metrics: baseMetrics,
      };
    }
    if (governanceBypass) {
      return {
        status: "error",
        label: "Governance bypass active",
        detail:
          "SYNESIS_YARN_GOVERNANCE_DISABLED is ON. Runtime policy wiring is bypassed, so capability-matrix gating is effectively disabled.",
        metrics: baseMetrics,
      };
    }
    if (!governanceStats?.enabled) {
      return {
        status: "error",
        label: "Governance client inactive",
        detail:
          "Yarn runtime did not start governance polling. Capability matrix entries are present but not currently consumed by the runtime.",
        metrics: baseMetrics,
      };
    }
    if ((governanceStats.errors ?? 0) > 0 && (governanceStats.updates ?? 0) === 0) {
      return {
        status: "warning",
        label: "Governance polling degraded",
        detail:
          "Governance client is enabled but has poll errors without successful updates. Verify admin endpoint reachability and auth token wiring.",
        metrics: baseMetrics,
      };
    }
    return {
      status: "ok",
      label: "Active in Yarn runtime",
      detail:
        "Capability matrix governance is enabled and polling in the active Yarn runtime. Overrides shown on this page are now enforceable.",
      metrics: baseMetrics,
    };
  }, [runtimeTelemetry, runtimeTelemetryLoading, runtimeTelemetryError]);

  const draftPreviewOverride = useMemo<CapabilityMatrixOverride | null>(() => {
    if (!data) return null;
    const selector = formSelector.trim();
    if (!selector) return null;
    const current = editingPolicyId ? data.overrides.find((row) => row.id === editingPolicyId) : null;
    const capabilities: Record<string, boolean> = {};
    for (const key of data.supported_capabilities) {
      capabilities[key] = Boolean(formCapabilities[key]);
    }
    return {
      id: current?.id ?? "__draft_override__",
      name: current?.name ?? "Draft override (unsaved)",
      enabled: formEnabled,
      scope: current?.scope ?? "platform",
      scope_value: current?.scope_value ?? "",
      org_id: current?.org_id ?? "",
      selector_type: formSelectorType,
      selector,
      priority: formPriority,
      capabilities,
      updated_at: current?.updated_at ?? null,
    };
  }, [data, formSelector, formSelectorType, formPriority, formEnabled, formCapabilities, editingPolicyId]);

  const preview = useMemo(() => {
    if (!data) return null;
    const overrides = (() => {
      if (!draftPreviewOverride) return data.overrides;
      if (editingPolicyId) {
        return data.overrides.map((row) => (row.id === editingPolicyId ? draftPreviewOverride : row));
      }
      return [...data.overrides, draftPreviewOverride];
    })();
    const previewMatrix: CapabilityMatrixEffective = { ...data, overrides };
    return resolvePreview(previewMatrix, {
      modelId: previewModelId,
      family: previewFamily,
      modelPath: previewPath,
    });
  }, [data, previewModelId, previewFamily, previewPath, draftPreviewOverride, editingPolicyId]);

  const registryCapabilityRows = useMemo<RegistryCapabilityRow[]>(() => {
    if (!data) return [];
    return assignedDeployments
      .map((row) => {
        const modelPath = row.model.trim();
        const modelId = row.served_name.trim() || modelPath;
        const family = inferCapabilityFamily(modelPath || modelId);
        const previewResult = resolvePreview(data, {
          modelId,
          family,
          modelPath,
        });
        const providerState = providerStatusByKey.get(row.provider);
        const providerNeedsKey = Boolean(providerState?.apiKeyEnv) && !providerState?.isLocal;
        return {
          role: row.role,
          provider: row.provider,
          modelId,
          modelPath,
          family,
          matchedLabels: previewResult.matchedLabels,
          resolved: previewResult.resolved,
          providerEnabled: providerState?.enabled ?? null,
          providerNeedsKey,
          providerKeyConfigured: providerNeedsKey ? (providerState?.apiKeyConfigured ?? null) : null,
        };
      })
      .filter((row) => row.modelId || row.modelPath)
      .sort((a, b) => a.role.localeCompare(b.role));
  }, [assignedDeployments, data, providerStatusByKey]);

  const legacySelectorCandidates = useMemo<LegacySelectorFixCandidate[]>(() => {
    if (!data) return [];
    return data.overrides
      .map((row) => {
        const registryChoices = registrySelectorCatalog[row.selector_type];
        if (registryChoices.length === 0) return null;
        const selector = row.selector.trim();
        if (!selector) return null;
        if (registryChoices.some((choice) => choice.value === selector)) return null;

        const normalizedSelector = normalizeSelector(selector);
        const normalizedMatches = registryChoices.filter(
          (choice) => normalizeSelector(choice.value) === normalizedSelector,
        );
        if (normalizedMatches.length === 1) {
          return {
            row,
            suggestions: registryChoices,
            suggestedSelector: normalizedMatches[0]?.value ?? selector,
            reason: "Case/format mismatch with a known registry selector.",
          } satisfies LegacySelectorFixCandidate;
        }

        if (row.selector_type !== "exact_model") {
          const prefixMatches = registryChoices.filter((choice) => {
            const normalizedChoice = normalizeSelector(choice.value);
            return normalizedChoice.startsWith(normalizedSelector) || normalizedSelector.startsWith(normalizedChoice);
          });
          if (prefixMatches.length === 1) {
            return {
              row,
              suggestions: registryChoices,
              suggestedSelector: prefixMatches[0]?.value ?? selector,
              reason: "Prefix mismatch; one canonical registry selector is likely intended.",
            } satisfies LegacySelectorFixCandidate;
          }
        }

        return {
          row,
          suggestions: registryChoices,
          suggestedSelector: null,
          reason: "No deterministic match found. Pick a canonical selector manually.",
        } satisfies LegacySelectorFixCandidate;
      })
      .filter((candidate): candidate is LegacySelectorFixCandidate => candidate !== null)
      .sort((a, b) => {
        const rank = selectorRank(a.row.selector_type) - selectorRank(b.row.selector_type);
        if (rank !== 0) return rank;
        return a.row.id.localeCompare(b.row.id);
      });
  }, [data, registrySelectorCatalog]);

  const presetSelectorFromPreview = useMemo(
    () =>
      selectorFromPreview(presetSelectorType, {
        modelId: previewModelId,
        family: previewFamily,
        modelPath: previewPath,
      }),
    [presetSelectorType, previewModelId, previewFamily, previewPath],
  );

  useEffect(() => {
    if (!data) return;
    const t = window.setTimeout(() => {
      setGlobalMode(data.mode);
      setGlobalEnabled(data.global_optimizations_enabled);
    }, 0);
    return () => window.clearTimeout(t);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const initial: Record<string, boolean> = {};
    for (const key of data.supported_capabilities) initial[key] = false;
    const t = window.setTimeout(() => {
      setFormCapabilities((prev) => (Object.keys(prev).length > 0 ? prev : initial));
    }, 0);
    return () => window.clearTimeout(t);
  }, [data]);

  useEffect(() => {
    let next = formSelector;
    if (formSelectorChoices.length === 0) {
      next = "";
    } else if (!formSelectorChoices.some((choice) => choice.value === formSelector.trim())) {
      next = formSelectorChoices[0]?.value ?? "";
    }
    if (next === formSelector) return;
    const t = window.setTimeout(() => setFormSelector(next), 0);
    return () => window.clearTimeout(t);
  }, [formSelectorChoices, formSelector]);

  useEffect(() => {
    let next = presetSelector;
    if (presetSelectorChoices.length === 0) {
      next = "";
    } else if (!presetSelectorChoices.some((choice) => choice.value === presetSelector.trim())) {
      next = presetSelectorChoices[0]?.value ?? "";
    }
    if (next === presetSelector) return;
    const t = window.setTimeout(() => setPresetSelector(next), 0);
    return () => window.clearTimeout(t);
  }, [presetSelectorChoices, presetSelector]);

  useEffect(() => {
    let next = previewModelId;
    if (previewModelChoices.length === 0) {
      next = "";
    } else if (!previewModelChoices.some((choice) => choice.value === previewModelId.trim())) {
      next = previewModelChoices[0]?.value ?? "";
    }
    if (next === previewModelId) return;
    const t = window.setTimeout(() => setPreviewModelId(next), 0);
    return () => window.clearTimeout(t);
  }, [previewModelChoices, previewModelId]);

  useEffect(() => {
    let next = previewFamily;
    if (previewFamilyChoices.length === 0) {
      next = "";
    } else if (!previewFamilyChoices.some((choice) => choice.value === previewFamily.trim())) {
      next = previewFamilyChoices[0]?.value ?? "";
    }
    if (next === previewFamily) return;
    const t = window.setTimeout(() => setPreviewFamily(next), 0);
    return () => window.clearTimeout(t);
  }, [previewFamilyChoices, previewFamily]);

  useEffect(() => {
    let next = previewPath;
    if (previewPathChoices.length === 0) {
      next = "";
    } else if (!previewPathChoices.some((choice) => choice.value === previewPath.trim())) {
      next = previewPathChoices[0]?.value ?? "";
    }
    if (next === previewPath) return;
    const t = window.setTimeout(() => setPreviewPath(next), 0);
    return () => window.clearTimeout(t);
  }, [previewPathChoices, previewPath]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setLegacyFixSelections((prev) => {
        if (legacySelectorCandidates.length === 0) {
          return Object.keys(prev).length > 0 ? {} : prev;
        }
        const next: Record<string, string> = {};
        for (const candidate of legacySelectorCandidates) {
          next[candidate.row.id] = candidate.suggestedSelector ?? "";
        }
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(next);
        if (
          prevKeys.length === nextKeys.length
          && nextKeys.every((key) => prev[key] === next[key])
        ) {
          return prev;
        }
        return next;
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [legacySelectorCandidates]);

  function resetForm(keys: string[]) {
    setEditingPolicyId(null);
    setFormSelectorType("exact_model");
    setFormSelector(registrySelectorCatalog.exact_model[0]?.value ?? "");
    setFormPriority(0);
    setFormEnabled(true);
    setFormError("");
    const next: Record<string, boolean> = {};
    for (const key of keys) next[key] = false;
    setFormCapabilities(next);
  }

  async function handleSubmitOverride() {
    if (!data) return;
    if (!formSelector.trim()) {
      setFormError("Selector is required.");
      return;
    }
    if (!formSelectorIsCanonical) {
      setFormError(`Selector must match a canonical ${SELECTOR_LABELS[formSelectorType]} value from Model Registry.`);
      return;
    }
    setFormError("");
    if (editingPolicyId) {
      await updateOverride.mutateAsync({
        policyId: editingPolicyId,
        selector_type: formSelectorType,
        selector: formSelector.trim(),
        priority: formPriority,
        enabled: formEnabled,
        scope: "platform",
        capabilities: formCapabilities,
      });
    } else {
      await createOverride.mutateAsync({
        selector_type: formSelectorType,
        selector: formSelector.trim(),
        priority: formPriority,
        enabled: formEnabled,
        scope: "platform",
        capabilities: formCapabilities,
      });
    }
    resetForm(data.supported_capabilities);
  }

  function handleStartEdit(row: CapabilityMatrixOverride) {
    setEditingPolicyId(row.id);
    setFormSelectorType(row.selector_type);
    const canonical = chooseCanonicalSelectorValue(
      registrySelectorCatalog[row.selector_type],
      row.selector_type,
      row.selector,
    );
    setFormSelector(canonical ?? row.selector);
    setFormPriority(row.priority);
    setFormEnabled(row.enabled);
    const next: Record<string, boolean> = {};
    for (const key of supportedCapabilities) {
      next[key] = Boolean(row.capabilities[key]);
    }
    setFormCapabilities(next);
  }

  async function handleToggleOverride(row: CapabilityMatrixOverride) {
    await updateOverride.mutateAsync({
      policyId: row.id,
      name: row.name,
      scope: row.scope,
      scope_value: row.scope_value,
      org_id: row.org_id,
      enabled: !row.enabled,
      selector_type: row.selector_type,
      selector: row.selector,
      priority: row.priority,
      capabilities: row.capabilities,
    });
  }

  async function handleSaveGlobal() {
    await updateGlobal.mutateAsync({
      mode: globalMode,
      global_optimizations_enabled: globalEnabled,
    });
  }

  async function handleApplyPreset(preset: CapabilityPreset) {
    if (!data) return;
    const selector = presetSelector.trim();
    if (!selector) {
      setPresetError("Preset selector is required.");
      return;
    }
    if (!presetSelectorIsCanonical) {
      setPresetError(`Selector must match a canonical ${SELECTOR_LABELS[presetSelectorType]} value from Model Registry.`);
      return;
    }
    setPresetError("");
    setPresetStatus("");

    if (presetApplyGlobalOff && (globalMode !== "enforced" || globalEnabled !== false)) {
      await updateGlobal.mutateAsync({
        mode: "enforced",
        global_optimizations_enabled: false,
      });
      setGlobalMode("enforced");
      setGlobalEnabled(false);
    }

    const capabilities = materializePresetCapabilities(data.supported_capabilities, preset.capabilities);
    const existing = data.overrides.find(
      (row) =>
        row.selector_type === presetSelectorType
        && normalizeSelector(row.selector) === normalizeSelector(selector),
    );

    if (existing) {
      await updateOverride.mutateAsync({
        policyId: existing.id,
        name: existing.name,
        scope: existing.scope,
        scope_value: existing.scope_value,
        org_id: existing.org_id,
        enabled: true,
        selector_type: presetSelectorType,
        selector,
        priority: preset.priority,
        capabilities,
      });
      setPresetStatus(`Updated override for ${SELECTOR_LABELS[presetSelectorType]}: ${selector}`);
      return;
    }

    await createOverride.mutateAsync({
      name: `Preset: ${preset.title}`,
      scope: "platform",
      enabled: true,
      selector_type: presetSelectorType,
      selector,
      priority: preset.priority,
      capabilities,
    });
    setPresetStatus(`Created override for ${SELECTOR_LABELS[presetSelectorType]}: ${selector}`);
  }

  function handleUsePreviewSelector() {
    if (!presetSelectorFromPreview) {
      setPresetError("Preview does not have a selector value for this selector type.");
      return;
    }
    setPresetError("");
    setPresetSelector(presetSelectorFromPreview);
  }

  function handleUseFormSelectorInPreview() {
    const selector = formSelector.trim();
    if (!selector) {
      setFormError("Enter a selector to preview.");
      return;
    }
    setFormError("");
    if (formSelectorType === "exact_model") {
      setPreviewModelId(selector);
      return;
    }
    if (formSelectorType === "family_prefix") {
      setPreviewFamily(selector);
      return;
    }
    setPreviewPath(selector);
  }

  async function handleApplyLegacyFix(row: CapabilityMatrixOverride) {
    const nextSelector = (legacyFixSelections[row.id] ?? "").trim();
    if (!nextSelector) {
      setLegacyFixError(`Select a canonical ${SELECTOR_LABELS[row.selector_type]} value first.`);
      return;
    }
    setLegacyFixError("");
    setLegacyFixStatus("");
    await updateOverride.mutateAsync({
      policyId: row.id,
      name: row.name,
      scope: row.scope,
      scope_value: row.scope_value,
      org_id: row.org_id,
      enabled: row.enabled,
      selector_type: row.selector_type,
      selector: nextSelector,
      priority: row.priority,
      capabilities: row.capabilities,
    });
    setLegacyFixStatus(`Updated ${SELECTOR_LABELS[row.selector_type]} override to "${nextSelector}".`);
  }

  async function handleAutoFixLegacySelectors() {
    const deterministic = legacySelectorCandidates
      .map((candidate) => ({
        candidate,
        selector: (legacyFixSelections[candidate.row.id] ?? "").trim(),
      }))
      .filter(({ candidate, selector }) =>
        Boolean(candidate.suggestedSelector)
        && selector.length > 0
        && selector !== candidate.row.selector.trim(),
      );

    if (deterministic.length === 0) {
      setLegacyFixError("");
      setLegacyFixStatus("No deterministic legacy selector fixes found.");
      return;
    }

    setLegacyFixError("");
    setLegacyFixStatus("");
    for (const { candidate, selector } of deterministic) {
      await updateOverride.mutateAsync({
        policyId: candidate.row.id,
        name: candidate.row.name,
        scope: candidate.row.scope,
        scope_value: candidate.row.scope_value,
        org_id: candidate.row.org_id,
        enabled: candidate.row.enabled,
        selector_type: candidate.row.selector_type,
        selector,
        priority: candidate.row.priority,
        capabilities: candidate.row.capabilities,
      });
    }
    setLegacyFixStatus(`Updated ${deterministic.length} legacy selector${deterministic.length === 1 ? "" : "s"}.`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Capability matrix</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Global OFF posture with explicit model/family/path capability overrides.
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Capability toggles are enforced only when Yarn runtime governance is enabled and actively polling this matrix.
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Selector picklists come from Model Registry assignments; legacy override cleanup is handled below.
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Strict mode: creating or saving overrides is blocked unless selector values are canonical registry values.
        </p>
        <a
          href="/settings/audit"
          className="mt-2 inline-block text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          View audit trail for matrix changes
        </a>
      </div>

      {error && <ApiErrorBanner error={error} />}

      {isLoading || !data ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : (
        <>
          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Runtime enforcement status</h2>
              <StatusBadge status={runtimeGovernanceStatus.status} label={runtimeGovernanceStatus.label} />
            </div>
            <p className={`mt-2 text-xs ${
              runtimeGovernanceStatus.status === "ok"
                ? "text-green-700 dark:text-green-300"
                : runtimeGovernanceStatus.status === "warning"
                  ? "text-amber-700 dark:text-amber-300"
                  : runtimeGovernanceStatus.status === "pending"
                    ? "text-gray-600 dark:text-gray-400"
                    : "text-red-700 dark:text-red-300"
            }`}>
              {runtimeGovernanceStatus.detail}
            </p>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {runtimeGovernanceStatus.metrics.map((metric) => (
                <div key={metric.label} className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {metric.label}
                  </dt>
                  <dd className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {metric.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Global posture</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Mode
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={globalMode}
                  onChange={(event) => {
                    setGlobalMode(event.target.value as CapabilityMatrixEffective["mode"]);
                  }}
                >
                  <option value="enforced">enforced</option>
                  <option value="shadow">shadow</option>
                </select>
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Global optimizations
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={String(globalEnabled)}
                  onChange={(event) => {
                    setGlobalEnabled(event.target.value === "true");
                  }}
                >
                  <option value="false">OFF</option>
                  <option value="true">ON</option>
                </select>
              </label>
              <div className="flex items-end">
                <button
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={updateGlobal.isPending}
                  onClick={handleSaveGlobal}
                >
                  {updateGlobal.isPending ? "Saving..." : "Save global posture"}
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recommended presets</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Apply a ready-made profile to a selector in one click.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Selector type
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={presetSelectorType}
                  onChange={(event) => setPresetSelectorType(event.target.value as CapabilitySelectorType)}
                >
                  {SELECTOR_TYPES.map((selectorType) => (
                    <option key={selectorType} value={selectorType}>
                      {SELECTOR_LABELS[selectorType]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300 md:col-span-2">
                Selector
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={presetSelector}
                  onChange={(event) => setPresetSelector(event.target.value)}
                  disabled={presetSelectorChoices.length === 0}
                >
                  {presetSelectorChoices.length === 0 ? (
                    <option value="">No selectors available — assign models in Model Registry first</option>
                  ) : (
                    presetSelectorChoices.map((choice) => (
                      <option key={`${choice.source}:${choice.value}`} value={choice.value}>
                        {choice.label}
                      </option>
                    ))
                  )}
                </select>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    onClick={handleUsePreviewSelector}
                    disabled={!presetSelectorFromPreview}
                  >
                    Use from preview
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {presetSelectorFromPreview
                      ? `${SELECTOR_LABELS[presetSelectorType]}: ${presetSelectorFromPreview}`
                      : "No value available from preview"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  Strict mode: canonical registry values only.
                </p>
              </label>
              <label className="flex items-end gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={presetApplyGlobalOff}
                  onChange={(event) => setPresetApplyGlobalOff(event.target.checked)}
                />
                Also set global mode to enforced + OFF
              </label>
            </div>
            {presetError && <p className="mt-2 text-sm text-red-600">{presetError}</p>}
            {presetStatus && <p className="mt-2 text-sm text-green-600">{presetStatus}</p>}
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              {RECOMMENDED_PRESETS.map((preset) => (
                <div key={preset.id} className="rounded border border-gray-200 p-3 dark:border-gray-700">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">{preset.title}</h3>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{preset.description}</p>
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                    Enables: {Object.entries(preset.capabilities).filter(([, value]) => value).map(([key]) => CAPABILITY_LABELS[key] ?? key).join(", ")}
                  </p>
                  <button
                    className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    onClick={() => handleApplyPreset(preset)}
                    disabled={
                      createOverride.isPending
                      || updateOverride.isPending
                      || updateGlobal.isPending
                      || !presetSelectorIsCanonical
                    }
                  >
                    Apply preset
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
              {editingPolicyId ? "Edit override" : "Create override"}
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Selector type
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={formSelectorType}
                  onChange={(event) => setFormSelectorType(event.target.value as CapabilitySelectorType)}
                >
                  {SELECTOR_TYPES.map((selectorType) => (
                    <option key={selectorType} value={selectorType}>
                      {SELECTOR_LABELS[selectorType]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Selector
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={formSelector}
                  onChange={(event) => setFormSelector(event.target.value)}
                  disabled={formSelectorChoices.length === 0}
                >
                  {formSelectorChoices.length === 0 ? (
                    <option value="">No selectors available — assign models in Model Registry first</option>
                  ) : (
                    formSelectorChoices.map((choice) => (
                      <option key={`${choice.source}:${choice.value}`} value={choice.value}>
                        {choice.label}
                      </option>
                    ))
                  )}
                </select>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    onClick={handleUseFormSelectorInPreview}
                    disabled={!formSelector.trim()}
                  >
                    Use in preview
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formSelector.trim()
                      ? `${SELECTOR_LABELS[formSelectorType]}: ${formSelector.trim()}`
                      : "Enter a selector to update preview context"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  Strict mode: canonical registry values only.
                </p>
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Priority
                <input
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  type="number"
                  value={formPriority}
                  onChange={(event) => setFormPriority(Number(event.target.value))}
                />
              </label>
              <label className="flex items-end gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={formEnabled}
                  onChange={(event) => setFormEnabled(event.target.checked)}
                />
                Row enabled
              </label>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {supportedCapabilities.map((capability) => (
                <label key={capability} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={formCapabilities[capability] ?? false}
                    onChange={(event) => {
                      setFormCapabilities((prev) => ({
                        ...prev,
                        [capability]: event.target.checked,
                      }));
                    }}
                  />
                  {CAPABILITY_LABELS[capability] ?? capability}
                </label>
              ))}
            </div>
            {formError && <p className="mt-2 text-sm text-red-600">{formError}</p>}
            <div className="mt-3 flex gap-2">
              <button
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={
                  createOverride.isPending
                  || updateOverride.isPending
                  || !formSelector.trim()
                  || !formSelectorIsCanonical
                }
                onClick={handleSubmitOverride}
              >
                {editingPolicyId
                  ? (updateOverride.isPending ? "Saving..." : "Save override")
                  : (createOverride.isPending ? "Creating..." : "Create override")}
              </button>
              <button
                className="rounded border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                onClick={() => resetForm(supportedCapabilities)}
              >
                {editingPolicyId ? "Cancel edit" : "Reset"}
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Overrides</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-2 py-2">Selector</th>
                    <th className="px-2 py-2">Priority</th>
                    <th className="px-2 py-2">Capabilities</th>
                    <th className="px-2 py-2">Enabled</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.overrides.map((row) => (
                    <tr key={row.id} className="border-b border-gray-50 dark:border-gray-800">
                      <td className="px-2 py-2 text-gray-700 dark:text-gray-200">
                        <div className="font-medium">{SELECTOR_LABELS[row.selector_type]}</div>
                        <div className="font-mono text-xs text-gray-500">{row.selector}</div>
                      </td>
                      <td className="px-2 py-2 text-gray-600 dark:text-gray-300">{row.priority}</td>
                      <td className="px-2 py-2 text-gray-600 dark:text-gray-300">{capabilitySummary(row)}</td>
                      <td className="px-2 py-2">{row.enabled ? "Yes" : "No"}</td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                            onClick={() => handleStartEdit(row)}
                          >
                            Edit
                          </button>
                          <button
                            className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                            onClick={() => handleToggleOverride(row)}
                            disabled={updateOverride.isPending}
                          >
                            {row.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                            onClick={() => deleteOverride.mutate(row.id)}
                            disabled={deleteOverride.isPending}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.overrides.length === 0 && (
                <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">No overrides configured.</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Legacy selector remediation</h2>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Existing overrides that do not exactly match current Model Registry selector values.
                </p>
              </div>
              <button
                type="button"
                className="rounded border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                disabled={updateOverride.isPending || legacySelectorCandidates.length === 0}
                onClick={handleAutoFixLegacySelectors}
              >
                Auto-fix deterministic matches
              </button>
            </div>
            {legacyFixError && <p className="mt-2 text-sm text-red-600">{legacyFixError}</p>}
            {legacyFixStatus && <p className="mt-2 text-sm text-green-600">{legacyFixStatus}</p>}
            {legacySelectorCandidates.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                All override selectors already match registry-backed canonical values.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      <th className="px-2 py-2">Selector type</th>
                      <th className="px-2 py-2">Current selector</th>
                      <th className="px-2 py-2">Canonical selector</th>
                      <th className="px-2 py-2">Reason</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {legacySelectorCandidates.map((candidate) => {
                      const selected = legacyFixSelections[candidate.row.id] ?? "";
                      const canApply = selected.trim().length > 0
                        && selected.trim() !== candidate.row.selector.trim();
                      return (
                        <tr key={candidate.row.id} className="border-b border-gray-50 dark:border-gray-800">
                          <td className="px-2 py-2 text-gray-700 dark:text-gray-200">
                            {SELECTOR_LABELS[candidate.row.selector_type]}
                          </td>
                          <td className="px-2 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
                            {candidate.row.selector}
                          </td>
                          <td className="px-2 py-2">
                            <select
                              className="block w-full rounded border px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                              value={selected}
                              onChange={(event) =>
                                setLegacyFixSelections((prev) => ({
                                  ...prev,
                                  [candidate.row.id]: event.target.value,
                                }))}
                            >
                              <option value="">Select canonical value…</option>
                              {candidate.suggestions.map((choice) => (
                                <option key={`${candidate.row.id}:${choice.value}`} value={choice.value}>
                                  {choice.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-300">{candidate.reason}</td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                              disabled={updateOverride.isPending || !canApply}
                              onClick={() => handleApplyLegacyFix(candidate.row)}
                            >
                              Apply fix
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Registry capability coverage</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Visualization of assigned registry models, selector identity, provider readiness, and resolved ON/OFF capability state.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-2 py-2">Role</th>
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Selectors</th>
                    <th className="px-2 py-2">Matched overrides</th>
                    {supportedCapabilities.map((capability) => (
                      <th key={capability} className="px-2 py-2">
                        {CAPABILITY_LABELS[capability] ?? capability}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {registryCapabilityRows.map((row) => (
                    <tr key={`${row.role}:${row.modelPath || row.modelId}`} className="border-b border-gray-50 dark:border-gray-800">
                      <td className="px-2 py-2 align-top text-gray-700 dark:text-gray-200">
                        <div className="font-medium">{row.role}</div>
                        <div className="font-mono text-xs text-gray-500">{row.modelId || "(missing)"}</div>
                      </td>
                      <td className="px-2 py-2 align-top text-xs text-gray-600 dark:text-gray-300">
                        <div className="font-medium">{row.provider || "unknown"}</div>
                        <div>
                          provider:{" "}
                          <span className={
                            row.providerEnabled == null
                              ? "text-gray-500"
                              : row.providerEnabled
                                ? "text-green-600"
                                : "text-red-600"
                          }>
                            {row.providerEnabled == null ? "unknown" : row.providerEnabled ? "enabled" : "disabled"}
                          </span>
                        </div>
                        <div>
                          key:{" "}
                          {row.providerEnabled == null ? (
                            <span className="text-gray-500">unknown</span>
                          ) : !row.providerNeedsKey ? (
                            <span className="text-gray-500">not required</span>
                          ) : row.providerKeyConfigured === true ? (
                            <span className="text-green-600">configured</span>
                          ) : (
                            <span className="text-amber-600">missing</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 align-top text-xs text-gray-600 dark:text-gray-300">
                        <div>
                          exact: <span className="font-mono">{row.modelId || "(empty)"}</span>
                        </div>
                        <div>
                          path: <span className="font-mono">{row.modelPath || "(empty)"}</span>
                        </div>
                        <div>
                          family: <span className="font-mono">{row.family || "(empty)"}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 align-top text-xs text-gray-600 dark:text-gray-300">
                        {row.matchedLabels.length > 0 ? row.matchedLabels.join(", ") : "none"}
                      </td>
                      {supportedCapabilities.map((capability) => {
                        const enabled = row.resolved[capability] ?? false;
                        return (
                          <td key={`${row.role}:${capability}`} className="px-2 py-2 align-top text-center">
                            <span className={`inline-flex rounded px-2 py-0.5 text-[10px] font-medium ${
                              enabled
                                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                            }`}>
                              {enabled ? "ON" : "OFF"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {registryCapabilityRows.length === 0 && (
                <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  No assigned models found in Model Registry.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Effective preview</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Model ID
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={previewModelId}
                  onChange={(event) => setPreviewModelId(event.target.value)}
                  disabled={previewModelChoices.length === 0}
                >
                  {previewModelChoices.length === 0 ? (
                    <option value="">No model IDs available</option>
                  ) : (
                    previewModelChoices.map((choice) => (
                      <option key={`${choice.source}:${choice.value}`} value={choice.value}>
                        {choice.label}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Family
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={previewFamily}
                  onChange={(event) => setPreviewFamily(event.target.value)}
                  disabled={previewFamilyChoices.length === 0}
                >
                  {previewFamilyChoices.length === 0 ? (
                    <option value="">No families available</option>
                  ) : (
                    previewFamilyChoices.map((choice) => (
                      <option key={`${choice.source}:${choice.value}`} value={choice.value}>
                        {choice.label}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Model path
                <select
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={previewPath}
                  onChange={(event) => setPreviewPath(event.target.value)}
                  disabled={previewPathChoices.length === 0}
                >
                  {previewPathChoices.length === 0 ? (
                    <option value="">No model paths available</option>
                  ) : (
                    previewPathChoices.map((choice) => (
                      <option key={`${choice.source}:${choice.value}`} value={choice.value}>
                        {choice.label}
                      </option>
                    ))
                  )}
                </select>
              </label>
            </div>
            <div className="mt-4 rounded border border-gray-100 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Matched overrides: {preview?.matchedLabels.join(", ") || "none"}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Preview includes your live create/edit selector when one is entered.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                {Object.entries(preview?.resolved ?? {}).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between rounded bg-white px-2 py-1 text-xs dark:bg-gray-900">
                    <span className="font-mono text-gray-700 dark:text-gray-300">{key}</span>
                    <span className={value ? "text-green-600" : "text-gray-500"}>{value ? "enabled" : "disabled"}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1">
                <p className="text-xs text-gray-500 dark:text-gray-400">Selector checks (updates as you type):</p>
                {(preview?.evaluations ?? []).map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between rounded bg-white px-2 py-1 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300"
                  >
                    <span>
                      {SELECTOR_LABELS[row.selectorType]}:{` `}
                      <span className="font-mono">{row.selector || "(empty)"}</span>
                      {!row.enabled ? " (disabled)" : ""}
                    </span>
                    <span className={row.matched ? "text-green-600" : "text-gray-500"}>
                      {row.matched ? "match" : `no match (${row.comparedFieldLabel}: ${row.comparedValue || "empty"})`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
