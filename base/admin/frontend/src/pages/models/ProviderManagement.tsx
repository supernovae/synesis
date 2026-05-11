import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  useProviderGovernance,
  useUpdateProviderConfig,
  useResetProviderConfig,
  useCreateProvider,
  useDeleteProvider,
  useSetProviderKey,
  useDeleteProviderKey,
} from "../../api/hooks";
import ProviderKeysPanel from "./ProviderKeysPanel";
import type { ProviderConfig, ProviderConfigInfo } from "../../types";
import {
  Cloud,
  Server,
  Check,
  X,
  Pencil,
  RotateCcw,
  Shield,
  Key,
  Plus,
  Trash2,
  Sparkles,
  Eye,
  EyeOff,
} from "lucide-react";

interface CreateForm {
  key: string;
  label: string;
  litellm_prefix: string;
  api_key_env: string;
  needs_endpoint: boolean;
  default_endpoint: string;
  placeholder: string;
  is_local: boolean;
}

const EMPTY_CREATE: CreateForm = {
  key: "",
  label: "",
  litellm_prefix: "openai/",
  api_key_env: "",
  needs_endpoint: true,
  default_endpoint: "",
  placeholder: "model-name",
  is_local: false,
};

interface EditForm {
  enabled: boolean;
  default_max_tokens: string;
  default_temperature: string;
  notes: string;
  /** Stored DB override; empty uses catalog default for built-in providers. */
  default_endpoint: string;
  label?: string;
  litellm_prefix?: string;
  api_key_env?: string;
  needs_endpoint?: boolean;
  placeholder?: string;
  is_local?: boolean;
}

export default function ProviderManagement() {
  const { data, isLoading } = useProviderGovernance();
  const location = useLocation();
  const updateMut = useUpdateProviderConfig();
  const resetMut = useResetProviderConfig();
  const createMut = useCreateProvider();
  const deleteMut = useDeleteProvider();
  const setKeyMut = useSetProviderKey();
  const deleteKeyMut = useDeleteProviderKey();

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyInputValue, setKeyInputValue] = useState("");
  const [showKeyPlain, setShowKeyPlain] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({ ...EMPTY_CREATE });

  const providers = useMemo(() => {
    const raw: ProviderConfigInfo[] = data?.providers ?? [];
    return [...raw].sort((a, b) => a.label.localeCompare(b.label));
  }, [data?.providers]);

  useEffect(() => {
    if (location.hash === "#provider-api-keys") {
      document.getElementById("provider-api-keys")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [location.hash, location.pathname]);

  const resetKeyEditor = () => {
    setKeyInputValue("");
    setShowKeyPlain(false);
    setKeyMut.reset();
    deleteKeyMut.reset();
  };

  const enabledCount = providers.filter((v) => v.enabled).length;
  const keyReadyCount = providers.filter((v) => {
    if (v.is_local || !v.api_key_env) return false;
    return v.api_key_configured === true;
  }).length;

  const openEdit = (v: ProviderConfigInfo) => {
    resetKeyEditor();
    setEditingKey(v.key);
    setEditForm({
      enabled: v.enabled,
      default_max_tokens: String(v.default_max_tokens),
      default_temperature: String(v.default_temperature),
      notes: v.notes,
      default_endpoint: v.config?.default_endpoint ?? v.default_endpoint ?? "",
      label: v.label,
      litellm_prefix: v.litellm_prefix,
      api_key_env: v.api_key_env,
      needs_endpoint: v.needs_endpoint,
      placeholder: v.placeholder,
      is_local: v.is_local,
    });
  };

  const editingProvider = providers.find((v) => v.key === editingKey);

  const showDefaultEndpointInEdit = useMemo(() => {
    if (!editingProvider || !editForm) return false;
    return editForm.needs_endpoint ?? true;
  }, [editingProvider, editForm]);

  const handleSave = () => {
    if (!editingKey || !editForm || !editingProvider) return;
    const payload: { providerKey: string } & Partial<ProviderConfig> & Record<string, unknown> = {
      providerKey: editingKey,
      enabled: editForm.enabled,
      default_max_tokens: Number(editForm.default_max_tokens) || 8192,
      default_temperature: Number(editForm.default_temperature) || 0.1,
      notes: editForm.notes,
    };
    payload.label = editForm.label;
    payload.litellm_prefix = editForm.litellm_prefix;
    payload.api_key_env = editForm.api_key_env;
    payload.needs_endpoint = editForm.needs_endpoint;
    payload.placeholder = editForm.placeholder;
    payload.is_local = editForm.is_local;
    const endpointApplies = editForm.needs_endpoint ?? true;
    if (endpointApplies) {
      payload.default_endpoint = editForm.default_endpoint ?? "";
    }
    updateMut.mutate(payload as Parameters<typeof updateMut.mutate>[0], {
      onSuccess: () => {
        resetKeyEditor();
        setEditingKey(null);
        setEditForm(null);
      },
    });
  };

  const handleReset = (key: string) => {
    if (!window.confirm("Reset this provider to catalog defaults? All overrides will be cleared."))
      return;
    resetMut.mutate(key);
  };

  const handleDelete = (key: string) => {
    if (!window.confirm(`Delete custom provider "${key}"? This cannot be undone.`)) return;
    deleteMut.mutate(key);
  };

  const handleCreate = () => {
    if (!createForm.key.trim() || !createForm.label.trim()) return;
    createMut.mutate(
      {
        key: createForm.key.trim().toLowerCase(),
        label: createForm.label.trim(),
        litellm_prefix: createForm.litellm_prefix,
        api_key_env: createForm.api_key_env,
        needs_endpoint: createForm.needs_endpoint,
        default_endpoint: createForm.needs_endpoint ? createForm.default_endpoint : "",
        placeholder: createForm.placeholder,
        is_local: createForm.is_local,
      },
      {
        onSuccess: () => {
          setShowCreate(false);
          setCreateForm({ ...EMPTY_CREATE });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Provider Management
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Enable or disable providers, set default policies, manage custom providers, and configure
            cluster API keys (same data as the former Settings → Provider Keys page).
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Provider
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Total Providers</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
            {providers.length}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Enabled</p>
          <p className="mt-1 text-2xl font-semibold text-green-600">{enabledCount}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Keys Configured</p>
          <p className="mt-1 text-2xl font-semibold text-blue-600">{keyReadyCount}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">API Key</th>
                <th className="px-4 py-3">Defaults</th>
                <th className="px-4 py-3">Base URL</th>
                <th className="px-4 py-3">Discovery</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {providers.map((v) => {
                const Icon = v.is_local ? Server : Cloud;
                const keyEnv = v.api_key_env;
                const keyOk =
                  !keyEnv ||
                  v.api_key_configured === true ||
                  v.api_key_configured === null;
                const isCustomized = !!v.config;
                return (
                  <tr key={v.key} className={!v.enabled ? "opacity-50" : ""}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-gray-400" />
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white">
                            {v.label}
                          </span>
                          <span className="ml-2 text-[10px] text-gray-400">{v.key}</span>
                          {v.is_custom && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-medium text-purple-600 dark:bg-purple-900/30 dark:text-purple-400">
                              <Sparkles className="h-2.5 w-2.5" />
                              Custom
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {v.enabled ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <Check className="h-2.5 w-2.5" /> Enabled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          <X className="h-2.5 w-2.5" /> Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {keyEnv ? (
                        <div className="flex items-center gap-1">
                          <Key
                            className={`h-3 w-3 ${keyOk ? "text-green-500" : "text-amber-500"}`}
                          />
                          <code className="text-[11px] text-gray-600 dark:text-gray-400">
                            {keyEnv}
                          </code>
                          <span
                            className={`text-[10px] ${keyOk ? "text-green-600" : "text-amber-600"}`}
                          >
                            {keyOk ? "\u2713" : "needed"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">\u2014</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                      <span>max_tok={v.default_max_tokens}</span>
                      <span className="ml-2">temp={v.default_temperature}</span>
                    </td>
                    <td className="max-w-[200px] px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                      {v.needs_endpoint && v.default_endpoint ? (
                        <span className="block truncate font-mono" title={v.default_endpoint}>
                          {v.default_endpoint}
                        </span>
                      ) : (
                        <span className="text-gray-400">\u2014</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {v.supports_discovery ? (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                          Available
                        </span>
                      ) : (
                        <span className="text-[10px] text-gray-400">\u2014</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(v)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800"
                          title="Edit provider config"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {v.is_custom ? (
                          <button
                            onClick={() => handleDelete(v.key)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
                            title="Delete custom provider"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          isCustomized && (
                            <button
                              onClick={() => handleReset(v.key)}
                              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-amber-600 dark:hover:bg-gray-800"
                              title="Reset to defaults"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section id="provider-api-keys" className="scroll-mt-8 space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Provider API keys</h2>
        <p className="text-sm text-gray-500">
          Keys live in the Kubernetes secret <code className="text-xs">provider-api-keys</code> in
          the provider key namespace. This panel uses the same read path as the provider table
          (GET /api/v1/provider-governance).
        </p>
        <ProviderKeysPanel governance={data} isLoading={isLoading} />
      </section>

      {/* Edit modal */}
      {editingKey && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              <Shield className="mr-2 inline h-5 w-5 text-blue-500" />
              Configure {editingProvider?.label ?? editingKey}
            </h3>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editForm.enabled}
                  onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })}
                  className="rounded"
                />
                <span className="text-gray-700 dark:text-gray-300">Show in Model Registry</span>
              </label>

              <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Display Label
                    </label>
                    <input
                      type="text"
                      value={editForm.label ?? ""}
                      onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                      className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Provider Prefix
                    </label>
                    <input
                      type="text"
                      value={editForm.litellm_prefix ?? ""}
                      onChange={(e) => setEditForm({ ...editForm, litellm_prefix: e.target.value })}
                      placeholder="openai/"
                      className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      API Key Env Var
                    </label>
                    <input
                      type="text"
                      value={editForm.api_key_env ?? ""}
                      onChange={(e) => setEditForm({ ...editForm, api_key_env: e.target.value })}
                      placeholder="MY_PROVIDER_API_KEY"
                      className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Placeholder Model Name
                    </label>
                    <input
                      type="text"
                      value={editForm.placeholder ?? ""}
                      onChange={(e) => setEditForm({ ...editForm, placeholder: e.target.value })}
                      className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    />
                  </div>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={editForm.needs_endpoint ?? true}
                        onChange={(e) =>
                          setEditForm({ ...editForm, needs_endpoint: e.target.checked })
                        }
                        className="rounded"
                      />
                      <span className="text-gray-700 dark:text-gray-300">Needs Endpoint URL</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={editForm.is_local ?? false}
                        onChange={(e) => setEditForm({ ...editForm, is_local: e.target.checked })}
                        className="rounded"
                      />
                      <span className="text-gray-700 dark:text-gray-300">Local</span>
                    </label>
                  </div>
              </>

              {showDefaultEndpointInEdit && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                    Default OpenAI-compatible base URL
                  </label>
                  <input
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    value={editForm.default_endpoint}
                    onChange={(e) => setEditForm({ ...editForm, default_endpoint: e.target.value })}
                    placeholder="https://example.com/v1"
                    className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  />
                  <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                    Pre-fills new role assignments in{" "}
                    <Link to="/models" className="underline hover:text-gray-700 dark:hover:text-gray-300">
                      Model Registry
                    </Link>
                    . Leave empty to use the catalog default for built-in providers. Per-role assignments can
                    still override.
                  </p>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Default Max Tokens
                </label>
                <input
                  type="number"
                  value={editForm.default_max_tokens}
                  onChange={(e) =>
                    setEditForm({ ...editForm, default_max_tokens: e.target.value })
                  }
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Default Temperature
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={editForm.default_temperature}
                  onChange={(e) =>
                    setEditForm({ ...editForm, default_temperature: e.target.value })
                  }
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Notes
                </label>
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={2}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>

              {(() => {
                const ke = (editingProvider?.api_key_env ?? "").trim();
                if (!ke || editingProvider?.is_local) return null;
                const configured = editingProvider?.api_key_configured === true;
                return (
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50/80 p-3 dark:border-indigo-800 dark:bg-indigo-950/25">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Key className="h-4 w-4 text-indigo-500" />
                      <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
                        Cluster API key
                      </span>
                      {configured ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                          Set in secret
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          Not set
                        </span>
                      )}
                    </div>
                    <p className="mb-2 text-[10px] leading-snug text-gray-600 dark:text-gray-400">
                      Writes <code className="rounded bg-white/80 px-1 font-mono dark:bg-gray-900/60">{ke}</code> in
                      the <code className="font-mono">provider-api-keys</code> secret for direct runtime consumers.
                      Saving a key restarts Planner and Yarn.{" "}
                      <a
                        href="#provider-api-keys"
                        className="text-indigo-700 underline dark:text-indigo-400"
                        onClick={() => {
                          resetKeyEditor();
                          setEditingKey(null);
                          setEditForm(null);
                        }}
                      >
                        All keys ↓
                      </a>
                    </p>
                    <div className="relative mb-2">
                      <input
                        type={showKeyPlain ? "text" : "password"}
                        value={keyInputValue}
                        onChange={(e) => setKeyInputValue(e.target.value)}
                        placeholder={configured ? "Paste new key to rotate…" : "Paste API key…"}
                        autoComplete="off"
                        className="w-full rounded border border-gray-300 bg-white py-1.5 pl-2 pr-9 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKeyPlain(!showKeyPlain)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        aria-label={showKeyPlain ? "Hide key" : "Show key"}
                      >
                        {showKeyPlain ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!keyInputValue.trim()) return;
                          setKeyMut.mutate(
                            { name: ke, value: keyInputValue.trim() },
                            {
                              onSuccess: () => {
                                setKeyInputValue("");
                                setShowKeyPlain(false);
                              },
                            },
                          );
                        }}
                        disabled={setKeyMut.isPending || !keyInputValue.trim()}
                        className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {setKeyMut.isPending ? "Saving…" : configured ? "Rotate key" : "Save key"}
                      </button>
                      {configured && (
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Remove ${ke} from the cluster secret? Models using this provider will fail until a new key is set.`,
                              )
                            )
                              return;
                            deleteKeyMut.mutate(ke, {
                              onSuccess: () => {
                                setKeyInputValue("");
                              },
                            });
                          }}
                          disabled={deleteKeyMut.isPending}
                          className="rounded border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40 disabled:opacity-50"
                        >
                          Remove from secret
                        </button>
                      )}
                    </div>
                    {(setKeyMut.isError || deleteKeyMut.isError) && (
                      <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                        {(setKeyMut.error as Error)?.message ??
                          (deleteKeyMut.error as Error)?.message ??
                          "Key update failed (platform admin required)."}
                      </p>
                    )}
                  </div>
                );
              })()}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => {
                    resetKeyEditor();
                    setEditingKey(null);
                    setEditForm(null);
                  }}
                  className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={updateMut.isPending}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {updateMut.isPending ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create provider modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              <Plus className="mr-2 inline h-5 w-5 text-blue-500" />
              Add Custom Provider
            </h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Provider Key <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={createForm.key}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
                    })
                  }
                  placeholder="my-provider"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
                <p className="mt-0.5 text-[10px] text-gray-400">
                  Lowercase, alphanumeric, dashes and underscores only
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Display Label <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={createForm.label}
                  onChange={(e) => setCreateForm({ ...createForm, label: e.target.value })}
                  placeholder="My Provider"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Provider Prefix
                </label>
                <input
                  type="text"
                  value={createForm.litellm_prefix}
                  onChange={(e) => setCreateForm({ ...createForm, litellm_prefix: e.target.value })}
                  placeholder="openai/"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  API Key Env Var
                </label>
                <input
                  type="text"
                  value={createForm.api_key_env}
                  onChange={(e) => setCreateForm({ ...createForm, api_key_env: e.target.value })}
                  placeholder="MY_PROVIDER_API_KEY"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Placeholder Model Name
                </label>
                <input
                  type="text"
                  value={createForm.placeholder}
                  onChange={(e) => setCreateForm({ ...createForm, placeholder: e.target.value })}
                  placeholder="model-name"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={createForm.needs_endpoint}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, needs_endpoint: e.target.checked })
                    }
                    className="rounded"
                  />
                  <span className="text-gray-700 dark:text-gray-300">Needs Endpoint URL</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={createForm.is_local}
                    onChange={(e) => setCreateForm({ ...createForm, is_local: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-gray-700 dark:text-gray-300">Local</span>
                </label>
              </div>
              {createForm.needs_endpoint && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                    Default OpenAI-compatible base URL
                  </label>
                  <input
                    type="url"
                    value={createForm.default_endpoint}
                    onChange={(e) => setCreateForm({ ...createForm, default_endpoint: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  />
                </div>
              )}
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                &quot;Needs Endpoint URL&quot; controls whether the Model Registry assign dialog shows an
                endpoint field. The default URL above pre-fills that dialog.
              </p>

              {createMut.isError && (
                <p className="text-xs text-red-600">
                  {(createMut.error as Error & { response?: { data?: { detail?: string } } })
                    ?.response?.data?.detail ??
                    createMut.error?.message ??
                    "Failed to create provider"}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => {
                    setShowCreate(false);
                    setCreateForm({ ...EMPTY_CREATE });
                    createMut.reset();
                  }}
                  className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={createMut.isPending || !createForm.key.trim() || !createForm.label.trim()}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {createMut.isPending ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
