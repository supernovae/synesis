import { useState } from "react";
import { useRoleAssignments, useProviderCatalog, useModelPolicies } from "../../api/hooks";
import type { ProviderInfo } from "../../types";
import type { PolicyRule } from "../../api/hooks";
import { Server, Cloud, Check, X, Info, ChevronRight, ChevronDown, ExternalLink, ShieldCheck } from "lucide-react";

const CONDITION_LABELS: Record<string, string> = {
  always: "Always",
  difficulty_lt: "Difficulty <",
  difficulty_gte: "Difficulty ≥",
  account_tier: "Account tier",
  user_preference: "User preference",
};

function PolicyBadge({ rule }: { rule: PolicyRule }) {
  const condLabel = CONDITION_LABELS[rule.condition_type] ?? rule.condition_type;
  const condText =
    rule.condition_type === "always"
      ? condLabel
      : `${condLabel} ${rule.condition_value}`;

  return (
    <div
      className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs ${
        rule.enabled
          ? "border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-900/20"
          : "border-gray-200 bg-gray-50 opacity-50 dark:border-gray-700 dark:bg-gray-800"
      }`}
    >
      <span className="font-medium text-gray-700 dark:text-gray-300">{condText}</span>
      <span className="text-gray-400">→</span>
      <span className="font-mono text-[11px] text-indigo-700 dark:text-indigo-300">{rule.model}</span>
      {rule.label && (
        <span className="text-[10px] text-gray-400">({rule.label})</span>
      )}
      {!rule.enabled && (
        <span className="rounded bg-gray-200 px-1 py-0.5 text-[9px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
          disabled
        </span>
      )}
    </div>
  );
}

export default function EffectiveServing() {
  const { data, isLoading } = useRoleAssignments();
  const { data: catalogData } = useProviderCatalog();
  const { data: policiesData } = useModelPolicies();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const roles = (data?.roles ?? []).filter((r) => r.is_active || r.assigned);
  const providers: Record<string, ProviderInfo> = catalogData?.providers ?? {};
  const policiesByRole: Record<string, PolicyRule[]> = policiesData?.policies ?? {};

  const activeCount = roles.filter((r) => r.is_active).length;
  const assignedCount = roles.filter((r) => r.assigned).length;
  const rolesWithPolicies = roles.filter(
    (r) => (policiesByRole[r.role]?.length ?? 0) > 0,
  ).length;

  const toggle = (role: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Effective Serving</h1>
        <p className="mt-1 text-sm text-gray-500">
          Unified view of active model serving — role assignments, endpoints, and conditional policies.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
        <p className="text-xs text-blue-700 dark:text-blue-300">
          Model serving is managed through the{" "}
          <a href="/models" className="font-medium underline hover:no-underline">
            Model Registry
          </a>
          ; conditional policies are configured in{" "}
          <a href="/models/policies" className="font-medium underline hover:no-underline">
            Model Policies
          </a>
          . Expand a row to see its active policies and full endpoint URL.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
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
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">With Policies</p>
          <p className="mt-1 text-2xl font-semibold text-indigo-600">{rolesWithPolicies}</p>
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
                <th className="w-8 px-2 py-3" />
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Endpoint</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Policies</th>
                <th className="px-4 py-3">Fallbacks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {roles.map((r) => {
                const providerKey = r.provider || "";
                const providerInfo = providers[providerKey];
                const Icon = providerInfo?.is_local ? Server : Cloud;
                const policies = policiesByRole[r.role] ?? [];
                const enabledPolicies = policies.filter((p) => p.enabled);
                const isExpanded = expanded.has(r.role);
                const hasDetail = policies.length > 0 || r.endpoint;

                return (
                  <>
                    <tr
                      key={r.id ?? r.role}
                      className={`${!r.is_active ? "opacity-50" : ""} ${hasDetail ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50" : ""}`}
                      onClick={() => hasDetail && toggle(r.role)}
                    >
                      <td className="px-2 py-3 text-center">
                        {hasDetail && (
                          <button
                            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            tabIndex={-1}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </td>
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
                        {enabledPolicies.length > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                            <ShieldCheck className="h-2.5 w-2.5" /> {enabledPolicies.length} rule{enabledPolicies.length !== 1 && "s"}
                          </span>
                        ) : (
                          <span className="text-[10px] text-gray-400">—</span>
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

                    {isExpanded && (
                      <tr key={`${r.role}-detail`}>
                        <td colSpan={8} className="bg-gray-50/50 px-6 py-4 dark:bg-gray-800/30">
                          <div className="space-y-4">
                            {/* Endpoint detail */}
                            {r.endpoint && (
                              <div>
                                <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                                  Endpoint
                                </h4>
                                <div className="flex items-center gap-2">
                                  <code className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                                    {r.endpoint}
                                  </code>
                                  <a
                                    href={r.endpoint}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-500 hover:text-blue-600"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                </div>
                              </div>
                            )}

                            {/* Policies */}
                            {policies.length > 0 ? (
                              <div>
                                <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                                  Conditional Policies ({enabledPolicies.length} active / {policies.length} total)
                                </h4>
                                <div className="flex flex-wrap gap-2">
                                  {policies.map((rule, i) => (
                                    <PolicyBadge key={rule.id ?? i} rule={rule} />
                                  ))}
                                </div>
                                <p className="mt-2 text-[10px] text-gray-400">
                                  Policies are evaluated in priority order; the first matching rule overrides the
                                  default model for this role.{" "}
                                  <a
                                    href={`/models/policies`}
                                    className="text-blue-500 underline hover:no-underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    Edit policies
                                  </a>
                                </p>
                              </div>
                            ) : (
                              <div>
                                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                                  Conditional Policies
                                </h4>
                                <p className="text-xs text-gray-400">
                                  No policies configured for this role — the default model assignment is always used.{" "}
                                  <a
                                    href="/models/policies"
                                    className="text-blue-500 underline hover:no-underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    Add policy
                                  </a>
                                </p>
                              </div>
                            )}

                            {/* Additional metadata */}
                            {(r.description || r.notes) && (
                              <div>
                                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                                  Notes
                                </h4>
                                <p className="text-xs text-gray-500">
                                  {r.description}
                                  {r.description && r.notes && " — "}
                                  {r.notes}
                                </p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
