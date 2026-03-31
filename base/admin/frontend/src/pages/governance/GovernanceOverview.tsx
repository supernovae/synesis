import { useQuery } from "@tanstack/react-query";
import { Shield, FileText, Scale, Clock } from "lucide-react";
import { Link } from "react-router-dom";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface GovernanceSummary {
  constitution_status_counts: Record<string, number>;
  active_maturity_modes: Record<string, number>;
  total_policies: number;
  recent_constitutions: ConstitutionSummary[];
}

interface ConstitutionSummary {
  id: number;
  constitution_id: string;
  name: string;
  version: number;
  status: string;
  scope: string;
  maturity_mode: string;
  updated_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  deprecated: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  archived: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const MATURITY_COLORS: Record<string, string> = {
  base: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  guided: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  governed: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  assured: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
};

export default function GovernanceOverview() {
  const { data, isLoading, error } = useQuery<GovernanceSummary>({
    queryKey: ["governance-summary"],
    queryFn: () => client.get("/governance/summary").then((r) => r.data),
    refetchInterval: 30_000,
  });

  const statusCounts = data?.constitution_status_counts ?? {};
  const maturityModes = data?.active_maturity_modes ?? {};
  const totalActive = statusCounts.active ?? 0;
  const totalDraft = statusCounts.draft ?? 0;
  const totalPolicies = data?.total_policies ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Governance</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage constitutions, policies, and organizational governance rules
        </p>
      </div>

      {error && <ApiErrorBanner error={error} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={Shield} label="Active Constitutions" value={totalActive} loading={isLoading} />
        <MetricCard icon={FileText} label="Draft Constitutions" value={totalDraft} loading={isLoading} />
        <MetricCard icon={Scale} label="Standalone Policies" value={totalPolicies} loading={isLoading} />
        <MetricCard icon={Clock} label="Maturity Modes" value={Object.keys(maturityModes).length} loading={isLoading} />
      </div>

      {Object.keys(maturityModes).length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Active Maturity Distribution</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(maturityModes).map(([mode, count]) => (
              <span key={mode} className={`rounded-full px-3 py-1 text-xs font-medium ${MATURITY_COLORS[mode] ?? "bg-gray-100 text-gray-600"}`}>
                {mode}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Recent Constitutions</h2>
          <Link to="/governance/constitutions" className="text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400">
            View all
          </Link>
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading...</div>
        ) : (data?.recent_constitutions ?? []).length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            No constitutions yet. <Link to="/governance/constitutions" className="text-blue-600 hover:underline">Create one</Link> to start governing.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase text-gray-500 dark:border-gray-800 dark:text-gray-400">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Version</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Scope</th>
                <th className="px-4 py-2">Maturity</th>
                <th className="px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent_constitutions ?? []).map((c) => (
                <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-2">
                    <Link to={`/governance/constitutions/${c.constitution_id}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">v{c.version}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[c.status] ?? ""}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{c.scope}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATURITY_COLORS[c.maturity_mode] ?? ""}`}>{c.maturity_mode}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {c.updated_at ? new Date(c.updated_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex gap-3">
        <Link to="/governance/constitutions" className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800">
          Manage Constitutions
        </Link>
        <Link to="/governance/policies" className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800">
          Manage Policies
        </Link>
        <Link to="/governance/effective" className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800">
          View Effective Rules
        </Link>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, loading }: { icon: React.ElementType; label: string; value: number; loading: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="rounded-lg bg-blue-50 p-2 dark:bg-blue-900/20">
        <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
        <p className="text-xl font-bold text-gray-900 dark:text-white">{loading ? "—" : value}</p>
      </div>
    </div>
  );
}
