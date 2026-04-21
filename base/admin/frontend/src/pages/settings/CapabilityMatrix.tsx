import { useEffect, useMemo, useState } from "react";
import {
  useCapabilityMatrix,
  useCreateCapabilityMatrixOverride,
  useDeleteCapabilityMatrixOverride,
  useUpdateCapabilityMatrixGlobal,
  useUpdateCapabilityMatrixOverride,
} from "../../api/hooks";
import type { CapabilityMatrixEffective, CapabilityMatrixOverride, CapabilitySelectorType } from "../../types";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

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
  const updateGlobal = useUpdateCapabilityMatrixGlobal();
  const createOverride = useCreateCapabilityMatrixOverride();
  const updateOverride = useUpdateCapabilityMatrixOverride();
  const deleteOverride = useDeleteCapabilityMatrixOverride();

  const [previewModelId, setPreviewModelId] = useState("qwen3.6-35b-a3b");
  const [previewFamily, setPreviewFamily] = useState("qwen3");
  const [previewPath, setPreviewPath] = useState("qwen3/qwen3.6-35b-a3b");
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
  const [presetSelector, setPresetSelector] = useState("qwen3.6-35b-a3b");
  const [presetApplyGlobalOff, setPresetApplyGlobalOff] = useState(true);
  const [presetError, setPresetError] = useState("");
  const [presetStatus, setPresetStatus] = useState("");

  const supportedCapabilities = data?.supported_capabilities ?? [];

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
    setGlobalMode(data.mode);
    setGlobalEnabled(data.global_optimizations_enabled);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    if (Object.keys(formCapabilities).length > 0) return;
    const initial: Record<string, boolean> = {};
    for (const key of data.supported_capabilities) initial[key] = false;
    setFormCapabilities(initial);
  }, [data, formCapabilities]);

  function resetForm(keys: string[]) {
    setEditingPolicyId(null);
    setFormSelectorType("exact_model");
    setFormSelector("");
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
    setFormSelector(row.selector);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Capability matrix</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Global OFF posture with explicit model/family/path capability overrides.
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Toggle labels map directly to runtime behavior; no code/env lookup needed for normal operation.
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
                <input
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={presetSelector}
                  onChange={(event) => setPresetSelector(event.target.value)}
                  placeholder="qwen3.6-35b-a3b"
                />
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
                    disabled={createOverride.isPending || updateOverride.isPending || updateGlobal.isPending}
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
                <input
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={formSelector}
                  onChange={(event) => setFormSelector(event.target.value)}
                  placeholder="qwen3.6-35b-a3b"
                />
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
                disabled={createOverride.isPending || updateOverride.isPending}
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
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Effective preview</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Model ID
                <input
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={previewModelId}
                  onChange={(event) => setPreviewModelId(event.target.value)}
                />
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Family
                <input
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={previewFamily}
                  onChange={(event) => setPreviewFamily(event.target.value)}
                />
              </label>
              <label className="text-sm text-gray-600 dark:text-gray-300">
                Model path
                <input
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={previewPath}
                  onChange={(event) => setPreviewPath(event.target.value)}
                />
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
