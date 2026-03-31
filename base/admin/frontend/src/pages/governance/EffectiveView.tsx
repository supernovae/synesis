import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Filter } from "lucide-react";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface EffectiveRule {
  source: string;
  constitution_id?: string;
  constitution_name?: string;
  policy_id?: string;
  policy_name?: string;
  maturity_mode?: string;
  scope: string;
  scope_precedence: number;
  precedence: number;
  clause_id?: string;
  category: string;
  constraint_kind: string;
  statement?: string;
  machine_rule?: Record<string, unknown>;
  rule_type?: string;
  rule_config?: Record<string, unknown>;
  priority: number;
}

const KIND_COLORS: Record<string, string> = {
  hard: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  guiding: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  advisory: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export default function EffectiveView() {
  const [orgId, setOrgId] = useState("");
  const [scope, setScope] = useState("");
  const [category, setCategory] = useState("");
  const [language, setLanguage] = useState("");

  const params: Record<string, string> = {};
  if (orgId) params.org_id = orgId;
  if (scope) params.scope = scope;
  if (category) params.category = category;
  if (language) params.language = language;

  const { data, isLoading, error } = useQuery<{ rules: EffectiveRule[]; total: number; etag: string }>({
    queryKey: ["governance-effective", params],
    queryFn: () => client.get("/governance/effective", { params }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const rules = data?.rules ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Effective Governance</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Merged view of active constitutions and standalone policies, prioritized by constraint kind and scope
        </p>
      </div>

      {error && <ApiErrorBanner error={error} />}

      <div className="flex flex-wrap gap-3">
        <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Org ID" value={orgId} onChange={(e) => setOrgId(e.target.value)} />
        <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All scopes</option>
          {["platform", "org", "tenant", "project", "team"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {["safety", "compliance", "quality", "style", "architecture", "tooling", "process"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Language filter" value={language} onChange={(e) => setLanguage(e.target.value)} />
      </div>

      {data && (
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span>{data.total} rules active</span>
          <span>ETag: {data.etag}</span>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading...</div>
        ) : rules.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <Eye className="h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="text-sm text-gray-500">No active governance rules</p>
            <p className="text-xs text-gray-400">Activate a constitution or create standalone policies to see effective rules</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {rules.map((r, i) => (
              <div key={r.clause_id ?? r.policy_id ?? i} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_COLORS[r.constraint_kind] ?? ""}`}>{r.constraint_kind}</span>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">{r.category}</span>
                  <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs text-purple-600 dark:bg-purple-900/20 dark:text-purple-400">{r.scope}</span>
                  <span className="text-xs text-gray-400">priority: {r.priority}</span>
                  {r.source === "constitution" && (
                    <span className="text-xs text-gray-400">from: {r.constitution_name} ({r.maturity_mode})</span>
                  )}
                  {r.source === "policy" && (
                    <span className="text-xs text-gray-400">policy: {r.policy_name}</span>
                  )}
                </div>
                {r.statement && <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{r.statement}</p>}
                {r.rule_type && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{r.rule_type}</span>
                    {r.rule_config && Object.keys(r.rule_config).length > 0 && (
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        {JSON.stringify(r.rule_config)}
                      </code>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
