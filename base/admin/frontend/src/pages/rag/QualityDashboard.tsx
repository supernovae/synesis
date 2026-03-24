import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQualitySummary } from "../../api/hooks";
import client from "../../api/client";
import MetricCard from "../../components/common/MetricCard";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { RefreshCw } from "lucide-react";

function useRefreshQuality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post("/rag/quality/refresh").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rag", "quality"] });
    },
  });
}

export default function QualityDashboard() {
  const { data, isLoading } = useQualitySummary();
  const refreshMutation = useRefreshQuality();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Quality Dashboard
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Per-domain corpus health scorecards
          </p>
        </div>
        <button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
          {refreshMutation.isPending ? "Refreshing..." : "Refresh Now"}
        </button>
      </div>

      <ApiErrorBanner error={refreshMutation.error} onDismiss={() => refreshMutation.reset()} />

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : !data ? (
        <EmptyState
          title="No quality data"
          description="Click 'Refresh Now' to compute quality scores from the corpus"
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Strong" value={data.strong} />
            <MetricCard label="Adequate" value={data.adequate} />
            <MetricCard label="Weak" value={data.weak} />
            <MetricCard label="Empty" value={data.empty} />
          </div>

          <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Domain</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Health</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Chunks</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Docs</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Freshness</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
                {data.scorecards?.map((sc) => (
                  <tr key={sc.domain} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-3 text-sm">
                      <Link
                        to={`/rag/quality/${sc.domain}`}
                        className="font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400"
                      >
                        {sc.domain}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <StatusBadge status={sc.health} />
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {(sc.chunk_count ?? sc.inventory?.total_chunks ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {(sc.doc_count ?? sc.inventory?.total_documents ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {(sc.freshness_pct ?? (sc.coverage?.hit_rate ?? 0) * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {refreshMutation.isSuccess && (
            <p className="text-sm text-green-600 dark:text-green-400">
              Quality scores refreshed successfully.
            </p>
          )}
        </>
      )}
    </div>
  );
}
