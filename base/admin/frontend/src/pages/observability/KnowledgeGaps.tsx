import { useState } from "react";
import {
  useObservabilityKnowledgeGaps,
  useKnowledgeGapStats,
  useResolveGap,
  useReopenGap,
  usePurgeGap,
} from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import { useAuth } from "../../components/auth/AuthProvider";

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-yellow-100 text-yellow-800" },
  resolved: { label: "Resolved", className: "bg-green-100 text-green-800" },
  reopened: { label: "Reopened", className: "bg-red-100 text-red-800" },
};

export default function KnowledgeGaps() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const { data, isLoading } = useObservabilityKnowledgeGaps({
    page,
    page_size: 20,
    status: statusFilter || undefined,
  });
  const { data: stats } = useKnowledgeGapStats();
  const gaps = data?.gaps ?? [];
  const { isAdmin } = useAuth();

  const resolveGap = useResolveGap();
  const reopenGap = useReopenGap();
  const purgeGap = usePurgeGap();

  const [resolveId, setResolveId] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  function handleResolve(chunkId: string) {
    resolveGap.mutate(
      { chunk_id: chunkId, resolution_note: resolveNote },
      { onSuccess: () => { setResolveId(null); setResolveNote(""); } }
    );
  }

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
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
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
            <p className="text-xs text-gray-500">Open</p>
            <p className="text-2xl font-bold text-yellow-600">
              {(stats as Record<string, unknown>).by_status
                ? ((stats as Record<string, unknown>).by_status as Record<string, number>).open ?? 0
                : "—"}
            </p>
          </div>
          <div className="rounded-lg border bg-white p-4">
            <p className="text-xs text-gray-500">Resolved</p>
            <p className="text-2xl font-bold text-green-600">
              {(stats as Record<string, unknown>).by_status
                ? ((stats as Record<string, unknown>).by_status as Record<string, number>).resolved ?? 0
                : "—"}
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

      <div className="flex gap-2">
        {["", "open", "resolved", "reopened"].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              statusFilter === s
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {resolveId && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-medium text-blue-900">
            Resolve gap: {resolveId.slice(0, 12)}…
          </p>
          <textarea
            placeholder="Resolution note (optional)"
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleResolve(resolveId)}
              disabled={resolveGap.isPending}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {resolveGap.isPending ? "Resolving…" : "Confirm Resolve"}
            </button>
            <button
              onClick={() => { setResolveId(null); setResolveNote(""); }}
              className="rounded-md bg-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-300"
            >
              Cancel
            </button>
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
                key: "status",
                label: "Status",
                sortable: true,
                render: (row) => {
                  const s = (row.status as string) || "open";
                  const badge = STATUS_BADGES[s] || STATUS_BADGES.open;
                  return (
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  );
                },
              },
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
              ...(isAdmin
                ? [
                    {
                      key: "_actions" as const,
                      label: "Actions",
                      render: (row: Record<string, unknown>) => {
                        const cid = row.chunk_id as string;
                        const st = (row.status as string) || "open";
                        return (
                          <div className="flex gap-1">
                            {st !== "resolved" && (
                              <button
                                onClick={() => setResolveId(cid)}
                                className="rounded px-2 py-0.5 text-xs font-medium text-green-700 hover:bg-green-50"
                              >
                                Resolve
                              </button>
                            )}
                            {st === "resolved" && (
                              <button
                                onClick={() => reopenGap.mutate(cid)}
                                className="rounded px-2 py-0.5 text-xs font-medium text-orange-700 hover:bg-orange-50"
                              >
                                Reopen
                              </button>
                            )}
                            <button
                              onClick={() => {
                                if (confirm("Permanently delete this gap?")) {
                                  purgeGap.mutate(cid);
                                }
                              }}
                              className="rounded px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                              Purge
                            </button>
                          </div>
                        );
                      },
                    },
                  ]
                : []),
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
