import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { useProviderKeys, useProviderCatalog, useSetProviderKey, useDeleteProviderKey, useLitellmRestartStatus } from "../../api/hooks";
import type { ProviderInfo } from "../../types";
import { Key, CheckCircle, XCircle, RotateCw, Trash2, AlertTriangle, Eye, EyeOff } from "lucide-react";

/** Env var names that may be set via this UI (matches backend allowlist = catalog with api_key_env). */
function catalogKeyEnvNames(providers: Record<string, ProviderInfo>): Set<string> {
  const s = new Set<string>();
  for (const p of Object.values(providers)) {
    if (p.api_key_env) s.add(p.api_key_env);
  }
  return s;
}

export default function ProviderKeys() {
  const { data: keys, isLoading } = useProviderKeys();
  const { data: catalogData } = useProviderCatalog();
  const { data: restartStatus } = useLitellmRestartStatus();
  const setKeyMut = useSetProviderKey();
  const deleteKeyMut = useDeleteProviderKey();

  const providers = useMemo(() => catalogData?.providers ?? {}, [catalogData]);
  const allowedNames = useMemo(() => catalogKeyEnvNames(providers), [providers]);
  const keyableProviders = useMemo(() => {
    return Object.entries(providers)
      .filter(([, p]) => p.api_key_env)
      .sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [providers]);

  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [addPicker, setAddPicker] = useState("");
  const [addKeyValue, setAddKeyValue] = useState("");
  const [showAddValue, setShowAddValue] = useState(false);

  const handleSave = (name: string) => {
    if (!keyValue.trim()) return;
    setKeyMut.mutate(
      { name, value: keyValue.trim() },
      { onSuccess: () => { setEditing(null); setKeyValue(""); setShowValue(false); } },
    );
  };

  const handleAddSave = () => {
    if (!addPicker || !addKeyValue.trim()) return;
    setKeyMut.mutate(
      { name: addPicker, value: addKeyValue.trim() },
      { onSuccess: () => { setAddPicker(""); setAddKeyValue(""); setShowAddValue(false); } },
    );
  };

  const handleDelete = (name: string) => {
    if (!confirm(`Remove ${name}? Models using this key will stop working until a new key is set.`)) return;
    deleteKeyMut.mutate(name);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Provider API Keys</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage API keys for LLM providers. Keys are stored as Kubernetes secrets and injected into the LiteLLM gateway.
          The provider list matches{" "}
          <Link to="/models" className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400">
            Models → Model Registry
          </Link>{" "}
          (edit role → Provider). Only those providers can be configured here for now.
        </p>
      </div>

      <ApiErrorBanner
        error={setKeyMut.error ?? deleteKeyMut.error}
        onDismiss={() => {
          setKeyMut.reset();
          deleteKeyMut.reset();
        }}
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-sm text-amber-800 dark:text-amber-300 space-y-1">
            <p>
              Adding or rotating a key triggers a brief LiteLLM gateway restart (~30s). Active requests may be interrupted.
            </p>
            <p className="text-amber-900/90 dark:text-amber-200/90">
              Assigning a model to a role in the registry does not upload keys — configure the matching env var here first
              (or the deployment will fail at runtime). A future "split roles" model (e.g. key owners vs. assigners) may
              change this; today both flows use the same catalog.
            </p>
            <p className="text-amber-900/90 dark:text-amber-200/90">
              Saving a key here performs the cluster secret update immediately and triggers LiteLLM rollout restart. You do
              not need to switch a model role away and back just to refresh keys.
            </p>
          </div>
        </div>
      </div>

      {restartStatus && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 text-sm">
              <p className="font-medium text-gray-800 dark:text-gray-100">
                LiteLLM rollout status
              </p>
              <p className="text-gray-600 dark:text-gray-300">
                {restartStatus.namespace}/{restartStatus.deployment}
              </p>
              <p className="text-gray-600 dark:text-gray-300">
                Last restart trigger:{" "}
                {restartStatus.restart_trigger_at
                  ? new Date(restartStatus.restart_trigger_at).toLocaleString()
                  : "not triggered yet"}
              </p>
              <p className="text-gray-600 dark:text-gray-300">
                Replicas ready {restartStatus.ready_replicas}/{restartStatus.desired_replicas}, updated {restartStatus.updated_replicas}
              </p>
            </div>
            <span
              className={
                restartStatus.rollout_observed && restartStatus.ready_replicas >= restartStatus.desired_replicas
                  ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              }
            >
              {restartStatus.rollout_observed && restartStatus.ready_replicas >= restartStatus.desired_replicas
                ? "Rollout healthy"
                : "Rollout in progress"}
            </span>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {(keys ?? []).map((k) => {
              const inCatalog = allowedNames.has(k.name);
              return (
              <div key={k.name} className="flex items-center gap-4 px-5 py-4">
                <Key className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-medium text-gray-800 dark:text-gray-200">{k.name}</span>
                    <span className="text-xs text-gray-400">{k.provider ?? ""}</span>
                    {!inCatalog && (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                        Legacy / manual secret
                      </span>
                    )}
                  </div>
                </div>

                {k.configured ? (
                  <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    <CheckCircle className="h-3 w-3" /> Configured
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    <XCircle className="h-3 w-3" /> Not set
                  </span>
                )}

                {editing === k.name ? (
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <input
                        type={showValue ? "text" : "password"}
                        value={keyValue}
                        onChange={(e) => setKeyValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSave(k.name); }}
                        placeholder="Paste API key..."
                        className="w-64 rounded border border-gray-300 bg-white px-3 py-1.5 pr-8 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowValue(!showValue)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSave(k.name)}
                      disabled={setKeyMut.isPending || !keyValue.trim()}
                      className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {setKeyMut.isPending ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditing(null); setKeyValue(""); setShowValue(false); }}
                      className="rounded px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    {inCatalog ? (
                      <button
                        type="button"
                        onClick={() => { setEditing(k.name); setKeyValue(""); }}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                        title={k.configured ? "Rotate key" : "Set key"}
                      >
                        <RotateCw className="h-3 w-3" />
                        {k.configured ? "Rotate" : "Set Key"}
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400" title="Keys outside the catalog must be changed in the cluster secret">
                        Set / rotate / remove via cluster secret
                      </span>
                    )}
                    {k.configured && inCatalog && (
                      <button
                        type="button"
                        onClick={() => handleDelete(k.name)}
                        disabled={deleteKeyMut.isPending}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                        title="Remove key from secret (catalog providers only)"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>

          <div className="border-t border-gray-100 px-5 py-4 dark:border-gray-800">
            <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">Add or rotate key</p>
            <div className="space-y-3">
              <select
                value={addPicker}
                onChange={(e) => { setAddPicker(e.target.value); setAddKeyValue(""); setShowAddValue(false); }}
                className="min-w-[220px] rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              >
                <option value="">Select provider…</option>
                {keyableProviders.map(([key, p]) => (
                  <option key={key} value={p.api_key_env}>
                    {p.label} ({p.api_key_env})
                  </option>
                ))}
              </select>

              {addPicker && (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showAddValue ? "text" : "password"}
                      value={addKeyValue}
                      onChange={(e) => setAddKeyValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleAddSave(); }}
                      placeholder={`Paste ${addPicker} value…`}
                      className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 pr-8 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowAddValue(!showAddValue)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showAddValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddSave}
                    disabled={setKeyMut.isPending || !addKeyValue.trim()}
                    className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {setKeyMut.isPending ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAddPicker(""); setAddKeyValue(""); setShowAddValue(false); }}
                    className="rounded px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-gray-400">
              To add a new provider to Synesis, extend the catalog (backend) first; a self-serve "add provider" UI may come later.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
