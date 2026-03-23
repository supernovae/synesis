import { useState } from "react";
import {
  useVendors,
  useUpdateVendor,
  useResetVendor,
  useProviderKeys,
} from "../../api/hooks";
import type { ProviderKeyStatus } from "../../api/hooks";
import type { VendorConfig, VendorInfo } from "../../types";
import {
  Cloud,
  Server,
  Check,
  X,
  Pencil,
  RotateCcw,
  Shield,
  Key,
} from "lucide-react";

export default function VendorManagement() {
  const { data, isLoading } = useVendors();
  const { data: providerKeysData } = useProviderKeys();
  const updateMut = useUpdateVendor();
  const resetMut = useResetVendor();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    enabled: boolean;
    default_max_tokens: string;
    default_temperature: string;
    notes: string;
  } | null>(null);

  const vendors: VendorInfo[] = data?.vendors ?? [];
  const configuredKeys = new Set(
    (providerKeysData ?? []).filter((k: ProviderKeyStatus) => k.configured).map((k) => k.name),
  );

  const enabledCount = vendors.filter((v) => v.enabled).length;
  const keyReadyCount = vendors.filter((v) => !v.is_local && v.api_key_env && configuredKeys.has(v.api_key_env)).length;

  const openEdit = (v: VendorInfo) => {
    setEditingKey(v.key);
    setEditForm({
      enabled: v.enabled,
      default_max_tokens: String(v.default_max_tokens),
      default_temperature: String(v.default_temperature),
      notes: v.notes,
    });
  };

  const handleSave = () => {
    if (!editingKey || !editForm) return;
    const payload: { providerKey: string } & Partial<VendorConfig> = {
      providerKey: editingKey,
      enabled: editForm.enabled,
      default_max_tokens: Number(editForm.default_max_tokens) || 8192,
      default_temperature: Number(editForm.default_temperature) || 0.1,
      notes: editForm.notes,
    };
    updateMut.mutate(
      payload,
      {
        onSuccess: () => {
          setEditingKey(null);
          setEditForm(null);
        },
      },
    );
  };

  const handleReset = (key: string) => {
    if (!window.confirm("Reset this vendor to catalog defaults? All overrides will be cleared.")) return;
    resetMut.mutate(key);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Vendor Management</h1>
        <p className="mt-1 text-sm text-gray-500">
          Enable or disable providers, set default policies, and view key status.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Total Providers</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{vendors.length}</p>
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
                <th className="px-4 py-3">Discovery</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {vendors.map((v) => {
                const Icon = v.is_local ? Server : Cloud;
                const keyEnv = v.api_key_env;
                const keyOk = !keyEnv || configuredKeys.has(keyEnv);
                const isCustomized = !!v.config;
                return (
                  <tr key={v.key} className={!v.enabled ? "opacity-50" : ""}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-gray-400" />
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white">{v.label}</span>
                          <span className="ml-2 text-[10px] text-gray-400">{v.key}</span>
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
                          <Key className={`h-3 w-3 ${keyOk ? "text-green-500" : "text-amber-500"}`} />
                          <code className="text-[11px] text-gray-600 dark:text-gray-400">{keyEnv}</code>
                          <span className={`text-[10px] ${keyOk ? "text-green-600" : "text-amber-600"}`}>
                            {keyOk ? "✓" : "needed"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                      <span>max_tok={v.default_max_tokens}</span>
                      <span className="ml-2">temp={v.default_temperature}</span>
                    </td>
                    <td className="px-4 py-3">
                      {v.supports_discovery ? (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                          Available
                        </span>
                      ) : (
                        <span className="text-[10px] text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(v)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800"
                          title="Edit vendor config"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {isCustomized && (
                          <button
                            onClick={() => handleReset(v.key)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-amber-600 dark:hover:bg-gray-800"
                            title="Reset to defaults"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
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

      {/* Edit modal */}
      {editingKey && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              <Shield className="mr-2 inline h-5 w-5 text-blue-500" />
              Configure {vendors.find((v) => v.key === editingKey)?.label ?? editingKey}
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
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Default Max Tokens</label>
                <input
                  type="number"
                  value={editForm.default_max_tokens}
                  onChange={(e) => setEditForm({ ...editForm, default_max_tokens: e.target.value })}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Default Temperature</label>
                <input
                  type="number"
                  step="0.1"
                  value={editForm.default_temperature}
                  onChange={(e) => setEditForm({ ...editForm, default_temperature: e.target.value })}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Notes</label>
                <textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={2}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => { setEditingKey(null); setEditForm(null); }}
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
    </div>
  );
}
