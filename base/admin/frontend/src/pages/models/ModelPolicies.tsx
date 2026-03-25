import { useState, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  GitBranch,
  Plus,
  Trash2,
  GripVertical,
  Save,
  ChevronDown,
  ChevronUp,
  ToggleLeft,
  ToggleRight,
  Undo2,
  Gauge,
} from "lucide-react";
import {
  useModelPolicies,
  useRolePolicies,
  useSaveRolePolicies,
  useDeleteRolePolicies,
  useRoleAssignments,
  type PolicyRule,
} from "../../api/hooks";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import EmptyState from "../../components/common/EmptyState";

const KNOWN_ROLES = ["router", "general", "critic", "coder", "summarizer"] as const;

const ROLE_DESCRIPTIONS: Record<string, string> = {
  router: "Fast LLM — entry_pipeline, planner, plan_gate, router nodes",
  general: "Writer + final_scrubber — general reasoning & synthesis",
  critic: "Deep reasoning — critic node evaluates drafts",
  coder: "IDE direct endpoint (Cursor, Claude Code) — not in planner graph",
  summarizer: "Pivot history summarization — router evidence compression",
};

const CONDITION_TYPES = [
  { value: "difficulty_lt", label: "Difficulty below", placeholder: "0.7" },
  { value: "difficulty_gte", label: "Difficulty at or above", placeholder: "0.7" },
  { value: "account_tier", label: "Account tier equals", placeholder: "pro" },
  { value: "user_preference", label: "User preference set", placeholder: "" },
  { value: "always", label: "Always (default fallback)", placeholder: "" },
] as const;

interface DraftRule {
  key: string;
  condition_type: string;
  condition_value: string;
  model: string;
  label: string;
  enabled: boolean;
}

let _ruleKey = 0;
function nextKey() {
  return `rule-${++_ruleKey}`;
}

function toDraftRules(rules: PolicyRule[]): DraftRule[] {
  return rules.map((r) => ({
    key: nextKey(),
    condition_type: r.condition_type,
    condition_value: r.condition_value,
    model: r.model,
    label: r.label,
    enabled: r.enabled,
  }));
}

function DifficultyPreview({ preview }: { preview: Record<string, string> }) {
  const entries = useMemo(
    () =>
      Object.entries(preview)
        .map(([k, v]) => [parseFloat(k), v] as const)
        .sort((a, b) => a[0] - b[0]),
    [preview],
  );
  if (entries.length === 0) return null;

  const models = [...new Set(entries.map(([, v]) => v))];
  const colorMap: Record<string, string> = {};
  const palette = [
    "bg-blue-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-violet-500",
  ];
  models.forEach((m, i) => {
    colorMap[m] = palette[i % palette.length];
  });

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
        <Gauge className="w-3.5 h-3.5" />
        <span>Difficulty preview</span>
      </div>
      <div className="flex h-5 rounded overflow-hidden border border-zinc-200 dark:border-zinc-700">
        {entries.map(([d, model], i) => {
          const next = i < entries.length - 1 ? entries[i + 1][0] : 1.0;
          const width = ((next - d) / 1.0) * 100;
          return (
            <div
              key={d}
              className={`${colorMap[model]} opacity-80 relative group`}
              style={{ width: `${width}%` }}
              title={`${d.toFixed(1)}–${next.toFixed(1)}: ${model}`}
            />
          );
        })}
      </div>
      <div className="flex gap-3 mt-1.5 flex-wrap">
        {models.map((m) => (
          <span key={m} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            <span className={`w-2.5 h-2.5 rounded-sm ${colorMap[m]}`} />
            {m || "(default)"}
          </span>
        ))}
      </div>
    </div>
  );
}

function RoleCard({ role }: { role: string }) {
  const { data, isLoading, error } = useRolePolicies(role);
  const { data: assignments } = useRoleAssignments();
  const saveMutation = useSaveRolePolicies();
  const deleteMutation = useDeleteRolePolicies();

  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<DraftRule[] | null>(null);
  const [dirty, setDirty] = useState(false);

  const currentRules = useMemo(() => data?.rules ?? [], [data]);
  const preview = useMemo(() => data?.preview ?? {}, [data]);
  const assignment = assignments?.roles?.find((r) => r.role === role);
  const defaultModel = assignment?.served_name || `synesis-${role}`;

  const editRules = useMemo(() => {
    if (draft !== null) return draft;
    return toDraftRules(currentRules);
  }, [draft, currentRules]);

  const startEditing = useCallback(() => {
    if (draft === null) {
      setDraft(toDraftRules(currentRules));
    }
    setExpanded(true);
  }, [draft, currentRules]);

  const updateRule = useCallback(
    (key: string, patch: Partial<DraftRule>) => {
      setDraft((prev) =>
        (prev ?? toDraftRules(currentRules)).map((r) =>
          r.key === key ? { ...r, ...patch } : r,
        ),
      );
      setDirty(true);
    },
    [currentRules],
  );

  const addRule = useCallback(() => {
    setDraft((prev) => [
      ...(prev ?? toDraftRules(currentRules)),
      {
        key: nextKey(),
        condition_type: "difficulty_lt",
        condition_value: "0.7",
        model: "",
        label: "",
        enabled: true,
      },
    ]);
    setDirty(true);
    setExpanded(true);
  }, [currentRules]);

  const removeRule = useCallback(
    (key: string) => {
      setDraft((prev) => (prev ?? toDraftRules(currentRules)).filter((r) => r.key !== key));
      setDirty(true);
    },
    [currentRules],
  );

  const moveRule = useCallback(
    (key: string, dir: -1 | 1) => {
      setDraft((prev) => {
        const arr = [...(prev ?? toDraftRules(currentRules))];
        const idx = arr.findIndex((r) => r.key === key);
        if (idx < 0) return arr;
        const target = idx + dir;
        if (target < 0 || target >= arr.length) return arr;
        [arr[idx], arr[target]] = [arr[target], arr[idx]];
        return arr;
      });
      setDirty(true);
    },
    [currentRules],
  );

  const handleSave = useCallback(async () => {
    const rules = (draft ?? toDraftRules(currentRules)).map((r, i) => ({
      priority: i,
      condition_type: r.condition_type,
      condition_value: r.condition_value,
      model: r.model,
      label: r.label,
      enabled: r.enabled,
    }));
    await saveMutation.mutateAsync({ role, rules });
    setDraft(null);
    setDirty(false);
  }, [draft, currentRules, role, saveMutation]);

  const handleDelete = useCallback(async () => {
    await deleteMutation.mutateAsync(role);
    setDraft(null);
    setDirty(false);
  }, [role, deleteMutation]);

  const handleReset = useCallback(() => {
    setDraft(null);
    setDirty(false);
  }, []);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
        onClick={() => (expanded ? setExpanded(false) : startEditing())}
      >
        <div className="flex items-center gap-3">
          <GitBranch className="w-4 h-4 text-zinc-400" />
          <div>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{role}</span>
            <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
              {ROLE_DESCRIPTIONS[role] || ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {currentRules.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
              {currentRules.length} rule{currentRules.length !== 1 ? "s" : ""}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-zinc-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-zinc-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-100 dark:border-zinc-800">
          <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Default model: <code className="text-zinc-700 dark:text-zinc-300">{defaultModel}</code>
            {assignment?.model && (
              <> (registry: <code>{assignment.model}</code>)</>
            )}
          </div>

          {isLoading && (
            <div className="mt-3 text-sm text-zinc-400">Loading...</div>
          )}
          {error && <div className="mt-3"><ApiErrorBanner error={error} /></div>}

          <div className="mt-3 space-y-2">
            {editRules.map((rule, idx) => (
              <div
                key={rule.key}
                className={`flex items-start gap-2 p-2.5 rounded border ${
                  rule.enabled
                    ? "border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50"
                    : "border-zinc-100 dark:border-zinc-800 bg-zinc-100/50 dark:bg-zinc-800/30 opacity-60"
                }`}
              >
                <div className="flex flex-col gap-0.5 pt-1">
                  <button
                    onClick={() => moveRule(rule.key, -1)}
                    disabled={idx === 0}
                    className="text-zinc-400 hover:text-zinc-600 disabled:opacity-30"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <GripVertical className="w-3.5 h-3.5 text-zinc-300" />
                  <button
                    onClick={() => moveRule(rule.key, 1)}
                    disabled={idx === editRules.length - 1}
                    className="text-zinc-400 hover:text-zinc-600 disabled:opacity-30"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex-1 grid grid-cols-[180px_100px_1fr_1fr] gap-2 items-center">
                  <select
                    value={rule.condition_type}
                    onChange={(e) => updateRule(rule.key, { condition_type: e.target.value })}
                    className="text-sm border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                  >
                    {CONDITION_TYPES.map((ct) => (
                      <option key={ct.value} value={ct.value}>
                        {ct.label}
                      </option>
                    ))}
                  </select>

                  {rule.condition_type !== "always" && rule.condition_type !== "user_preference" ? (
                    <input
                      type="text"
                      value={rule.condition_value}
                      onChange={(e) => updateRule(rule.key, { condition_value: e.target.value })}
                      placeholder={CONDITION_TYPES.find((c) => c.value === rule.condition_type)?.placeholder || ""}
                      className="text-sm border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    />
                  ) : (
                    <div />
                  )}

                  <input
                    type="text"
                    value={rule.model}
                    onChange={(e) => updateRule(rule.key, { model: e.target.value })}
                    placeholder="LiteLLM model name"
                    className="text-sm border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                  />

                  <input
                    type="text"
                    value={rule.label}
                    onChange={(e) => updateRule(rule.key, { label: e.target.value })}
                    placeholder="Label (optional)"
                    className="text-sm border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                  />
                </div>

                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    onClick={() => updateRule(rule.key, { enabled: !rule.enabled })}
                    className="text-zinc-400 hover:text-zinc-600"
                    title={rule.enabled ? "Disable" : "Enable"}
                  >
                    {rule.enabled ? (
                      <ToggleRight className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <ToggleLeft className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => removeRule(rule.key)}
                    className="text-zinc-400 hover:text-red-500"
                    title="Remove rule"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={addRule}
              className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700"
            >
              <Plus className="w-3.5 h-3.5" /> Add rule
            </button>
          </div>

          {preview && Object.keys(preview).length > 0 && !dirty && (
            <DifficultyPreview preview={preview} />
          )}

          <div className="mt-4 flex items-center gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-3">
            <button
              onClick={handleSave}
              disabled={!dirty || saveMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-3.5 h-3.5" />
              {saveMutation.isPending ? "Saving..." : "Save"}
            </button>
            {dirty && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                <Undo2 className="w-3.5 h-3.5" /> Reset
              </button>
            )}
            {currentRules.length > 0 && (
              <button
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 hover:text-red-600 ml-auto"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {deleteMutation.isPending ? "Removing..." : "Remove all rules"}
              </button>
            )}
          </div>
          {saveMutation.error && <div className="mt-2"><ApiErrorBanner error={saveMutation.error} /></div>}
        </div>
      )}
    </div>
  );
}

export default function ModelPolicies() {
  const { data: allPolicies, isLoading } = useModelPolicies();
  const configuredRoles = useMemo(
    () =>
      allPolicies?.policies
        ? Object.keys(allPolicies.policies).filter((r) => allPolicies.policies[r].length > 0)
        : [],
    [allPolicies],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            Model Policies
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Conditional model selection per role. Define rules to route LLM calls to
            different models based on task difficulty, account tier, or other conditions.
            Roles without policies use the{" "}
            <Link to="/models" className="text-blue-600 dark:text-blue-400 hover:underline">
              registry default
            </Link>.
          </p>
        </div>
      </div>

      {isLoading && (
        <EmptyState
          icon={GitBranch}
          title="Loading policies..."
        />
      )}

      {configuredRoles.length > 0 && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {configuredRoles.length} role{configuredRoles.length !== 1 ? "s" : ""} with active
          policies: {configuredRoles.join(", ")}
        </div>
      )}

      <div className="space-y-3">
        {KNOWN_ROLES.map((role) => (
          <RoleCard key={role} role={role} />
        ))}
      </div>
    </div>
  );
}
