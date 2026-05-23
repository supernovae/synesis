import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQualitySummary } from "../../api/hooks";
import client from "../../api/client";
import MetricCard from "../../components/common/MetricCard";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { AlertTriangle, RefreshCw } from "lucide-react";

function useRefreshQuality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post("/rag/quality/refresh").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rag", "quality"] });
    },
  });
}

function formatCount(value?: number | null) {
  return (value ?? 0).toLocaleString();
}

function formatPct(value?: number | null) {
  if (value == null) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function formatScore(value?: number | null) {
  return value == null ? "—" : value.toFixed(2);
}

export default function QualityDashboard() {
  const { data, isLoading } = useQualitySummary();
  const refreshMutation = useRefreshQuality();
  const warnings = data?.warnings ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Quality Dashboard
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Read-only per-domain health scorecards computed from the NornicDB content graph
          </p>
        </div>
        <button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
          {refreshMutation.isPending ? "Refreshing..." : "Refresh from NornicDB"}
        </button>
      </div>

      <ApiErrorBanner error={refreshMutation.error} onDismiss={() => refreshMutation.reset()} />
      {warnings.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <div>
            <div className="font-medium">Quality data is degraded</div>
            <div className="mt-1">{warnings.map((warning) => warning.message).join(" ")}</div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : !data ? (
        <EmptyState
          title="No quality data"
          description="Refresh from NornicDB to compute health scores from current content graph nodes"
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Strong" value={data.strong} />
            <MetricCard label="Adequate" value={data.adequate} />
            <MetricCard label="Weak" value={data.weak} />
            <MetricCard label="Empty" value={data.empty} />
          </div>
          {data.source && (
            <p className="text-xs text-gray-500">
              Source: {data.source === "nornicdb" ? "current NornicDB content graph" : data.source}
            </p>
          )}

          <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Scope</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Health</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Content</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Docs / Sources</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Embeddings</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Edges</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Signals</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Quality</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
                {data.scorecards?.map((sc) => (
                  <tr key={sc.domain} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-3 text-sm">
                      <Link
                        to={`/rag/quality/${encodeURIComponent(sc.domain)}`}
                        className="font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400"
                      >
                        {sc.display_name ?? sc.pack_id ?? sc.domain}
                      </Link>
                      {sc.path && <div className="mt-0.5 text-xs text-gray-500">{sc.path}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <StatusBadge status={sc.health} />
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {formatCount(sc.chunk_count ?? sc.inventory?.total_chunks)}
                      {sc.node_count != null && sc.node_count !== (sc.chunk_count ?? sc.inventory?.total_chunks) && (
                        <div className="text-xs text-gray-500">{formatCount(sc.node_count)} nodes</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {formatCount(sc.doc_count ?? sc.inventory?.total_documents)}
                      <div className="text-xs text-gray-500">{formatCount(sc.inventory?.total_sources)} sources</div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {formatCount(sc.embedding_count)}
                      <div className="text-xs text-gray-500">{formatPct(sc.embedding_coverage ?? sc.coverage?.hit_rate)}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {formatCount(sc.edge_count)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {formatCount((sc.example_count ?? 0) + (sc.context_card_count ?? 0) + (sc.constraint_count ?? 0))}
                      <div className="text-xs text-gray-500">
                        {formatCount(sc.example_count)} ex · {formatCount(sc.context_card_count)} cards
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                      {formatScore(sc.quality_score)}
                      <div className="text-xs text-gray-500">
                        trust {formatScore(sc.trust_score)} · fresh {formatScore(sc.freshness_score)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {refreshMutation.isSuccess && (
            <p className="text-sm text-green-600 dark:text-green-400">
              Quality scores refreshed successfully from current NornicDB pack reports.
            </p>
          )}
        </>
      )}
    </div>
  );
}
