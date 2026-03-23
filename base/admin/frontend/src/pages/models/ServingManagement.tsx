import { useRoleAssignments, useProviderCatalog } from "../../api/hooks";
import type { ProviderInfo } from "../../types";
import { Server, Cloud, Check, X, Info } from "lucide-react";

export default function EffectiveServing() {
  const { data, isLoading } = useRoleAssignments();
  const { data: catalogData } = useProviderCatalog();

  const roles = (data?.roles ?? []).filter((r) => r.is_active || r.assigned);
  const providers: Record<string, ProviderInfo> = catalogData?.providers ?? {};

  const activeCount = roles.filter((r) => r.is_active).length;
  const assignedCount = roles.filter((r) => r.assigned).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Effective Serving</h1>
        <p className="mt-1 text-sm text-gray-500">
          Read-only view of active model serving, derived from Model Registry role assignments.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
        <p className="text-xs text-blue-700 dark:text-blue-300">
          Model serving is managed through the{" "}
          <a href="/models" className="font-medium underline hover:no-underline">
            Model Registry
          </a>
          . This page shows the derived operational view — what roles are currently
          serving which models. To change assignments, edit roles in the Registry.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Total Roles</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{roles.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Active in Gateway</p>
          <p className="mt-1 text-2xl font-semibold text-green-600">{activeCount}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Assigned</p>
          <p className="mt-1 text-2xl font-semibold text-blue-600">{assignedCount}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : roles.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center dark:border-gray-600">
          <Server className="mx-auto h-8 w-8 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No active roles</h3>
          <p className="mt-1 text-xs text-gray-500">
            Assign models to roles in the Model Registry to see effective serving here.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Endpoint</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Fallbacks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {roles.map((r) => {
                const providerKey = r.provider || "";
                const providerInfo = providers[providerKey];
                const Icon = providerInfo?.is_local ? Server : Cloud;
                return (
                  <tr key={r.id ?? r.role} className={!r.is_active ? "opacity-50" : ""}>
                    <td className="px-4 py-3">
                      <div>
                        <span className="font-medium text-gray-900 dark:text-white">{r.role}</span>
                        {r.served_name && r.served_name !== r.role && (
                          <span className="ml-2 text-[10px] text-gray-400">{r.served_name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5 text-gray-400" />
                        <span className="text-gray-700 dark:text-gray-300">
                          {providerInfo?.label ?? (providerKey || "—")}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-gray-600 dark:text-gray-400">{r.model || "—"}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="truncate text-[11px] text-gray-400" title={r.endpoint}>
                        {r.endpoint ? r.endpoint.replace(/https?:\/\//, "").slice(0, 40) : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.is_active ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <Check className="h-2.5 w-2.5" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          <X className="h-2.5 w-2.5" /> Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.fallbacks && r.fallbacks.length > 0 ? (
                        <span className="text-xs text-gray-500">{r.fallbacks.join(", ")}</span>
                      ) : (
                        <span className="text-[10px] text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
