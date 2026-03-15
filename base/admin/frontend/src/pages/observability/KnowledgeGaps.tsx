import { useState } from "react";
import { useKnowledgeGaps, useKnowledgeGapStats } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";

export default function KnowledgeGaps() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useKnowledgeGaps({ page, page_size: 20 });
  const { data: stats } = useKnowledgeGapStats();
  const gaps = data?.gaps ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Knowledge Gaps
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Queries where local RAG confidence was low — candidates for corpus
          improvement
        </p>
      </div>

      {stats && stats.total_gaps > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border bg-white p-4">
            <p className="text-xs text-gray-500">Total Gaps</p>
            <p className="text-2xl font-bold">{stats.total_gaps}</p>
          </div>
          <div className="rounded-lg border bg-white p-4">
            <p className="text-xs text-gray-500">Avg Confidence</p>
            <p className="text-2xl font-bold">
              {(stats.avg_score * 100).toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg border bg-white p-4">
            <p className="text-xs text-gray-500">Contexts</p>
            <p className="text-sm">
              {Object.entries(stats.by_context || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ") || "—"}
            </p>
          </div>
          <div className="rounded-lg border bg-white p-4">
            <p className="text-xs text-gray-500">Languages</p>
            <p className="text-sm">
              {Object.entries(stats.by_language || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ") || "—"}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : gaps.length === 0 ? (
        <EmptyState title="No knowledge gaps recorded" />
      ) : (
        <>
          <DataTable
            columns={[
              {
                key: "query",
                label: "Query",
                className: "max-w-sm truncate",
              },
              {
                key: "max_score",
                label: "Confidence",
                sortable: true,
                render: (row) => {
                  const v = row.max_score;
                  return typeof v === "number"
                    ? `${(v * 100).toFixed(1)}%`
                    : String(v ?? "");
                },
              },
              { key: "platform_context", label: "Context", sortable: true },
              { key: "language", label: "Language", sortable: true },
              {
                key: "task_description",
                label: "Task",
                className: "max-w-xs truncate",
              },
              {
                key: "timestamp",
                label: "Time",
                sortable: true,
                render: (row) => {
                  const v = row.timestamp;
                  return typeof v === "number"
                    ? new Date(v * 1000).toLocaleString()
                    : String(v ?? "");
                },
              },
            ]}
            data={gaps}
            keyField="chunk_id"
          />
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              Previous
            </button>
            <span className="py-1 text-sm text-gray-500">Page {page}</span>
            <button
              disabled={gaps.length < 20}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
