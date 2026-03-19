import { useState } from "react";
import { useProviderKeys, useSetProviderKey, useDeleteProviderKey } from "../../api/hooks";
import { Key, CheckCircle, XCircle, RotateCw, Trash2, AlertTriangle, Eye, EyeOff } from "lucide-react";

export default function ProviderKeys() {
  const { data: keys, isLoading } = useProviderKeys();
  const setKeyMut = useSetProviderKey();
  const deleteKeyMut = useDeleteProviderKey();

  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [customName, setCustomName] = useState("");

  const handleSave = (name: string) => {
    if (!keyValue.trim()) return;
    setKeyMut.mutate(
      { name, value: keyValue.trim() },
      { onSuccess: () => { setEditing(null); setKeyValue(""); setShowValue(false); } },
    );
  };

  const handleDelete = (name: string) => {
    if (!confirm(`Remove ${name}? Models using this key will stop working until a new key is set.`)) return;
    deleteKeyMut.mutate(name);
  };

  const handleAddCustom = () => {
    const name = customName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!name) return;
    setEditing(name);
    setCustomName("");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Provider API Keys</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage API keys for LLM providers. Keys are stored as Kubernetes secrets and injected into the LiteLLM gateway.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Adding or rotating a key triggers a brief LiteLLM gateway restart (~30s). Active requests may be interrupted.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {(keys ?? []).map((k) => (
              <div key={k.name} className="flex items-center gap-4 px-5 py-4">
                <Key className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-gray-800 dark:text-gray-200">{k.name}</span>
                    <span className="text-xs text-gray-400">{(k as any).provider ?? ""}</span>
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
                        placeholder="Paste API key..."
                        className="w-64 rounded border border-gray-300 bg-white px-3 py-1.5 pr-8 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                        autoFocus
                      />
                      <button
                        onClick={() => setShowValue(!showValue)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <button
                      onClick={() => handleSave(k.name)}
                      disabled={setKeyMut.isPending || !keyValue.trim()}
                      className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {setKeyMut.isPending ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => { setEditing(null); setKeyValue(""); setShowValue(false); }}
                      className="rounded px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setEditing(k.name); setKeyValue(""); }}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                      title={k.configured ? "Rotate key" : "Set key"}
                    >
                      <RotateCw className="h-3 w-3" />
                      {k.configured ? "Rotate" : "Set Key"}
                    </button>
                    {k.configured && (
                      <button
                        onClick={() => handleDelete(k.name)}
                        disabled={deleteKeyMut.isPending}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                        title="Remove key"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add custom provider */}
          <div className="border-t border-gray-100 px-5 py-4 dark:border-gray-800">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="CUSTOM_PROVIDER_API_KEY"
                className="w-64 rounded border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                onKeyDown={(e) => e.key === "Enter" && handleAddCustom()}
              />
              <button
                onClick={handleAddCustom}
                disabled={!customName.trim()}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Add Custom Provider
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Use UPPER_SNAKE_CASE. The env var name must match what your model config references (e.g. os.environ/MY_KEY).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
