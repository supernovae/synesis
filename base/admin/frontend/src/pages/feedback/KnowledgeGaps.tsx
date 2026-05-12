import { useState } from "react";
import {
  useKnowledgeGaps,
  useSubmitKnowledge,
  useResolveGap,
  useReopenGap,
  usePurgeGap,
} from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import { useAuth } from "../../components/auth/useAuth";

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-yellow-100 text-yellow-800" },
  resolved: { label: "Resolved", className: "bg-green-100 text-green-800" },
  reopened: { label: "Reopened", className: "bg-red-100 text-red-800" },
};

export default function KnowledgeGaps() {
  const [statusFilter, setStatusFilter] = useState("");
  const { data, isLoading } = useKnowledgeGaps({
    status: statusFilter || undefined,
  } as Record<string, unknown>);
  const gaps = data?.gaps ?? [];
  const { isAdmin } = useAuth();
  const submit = useSubmitKnowledge();
  const [domain, setDomain] = useState("");
  const [content, setContent] = useState("");

  const resolveGap = useResolveGap();
  const reopenGap = useReopenGap();
  const purgeGap = usePurgeGap();

  const [resolveId, setResolveId] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!domain.trim() || !content.trim()) return;
    submit.mutate(
      { domain: domain.trim(), content: content.trim() },
      { onSuccess: () => { setDomain(""); setContent(""); } }
    );
  }

  function handleResolve(chunkId: string) {
    resolveGap.mutate(
      { chunk_id: chunkId, resolution_note: resolveNote },
      { onSuccess: () => { setResolveId(null); setResolveNote(""); } }
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Knowledge Gaps</h1>
        <p className="mt-1 text-sm text-gray-500">
          Queries with low RAG confidence -- fill gaps by submitting content
        </p>
      </div>

      {isAdmin && (
        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-gray-200 bg-white p-5 space-y-3"
        >
          <h3 className="text-sm font-medium text-gray-900">Submit Knowledge</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <input
              placeholder="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <textarea
              placeholder="Content to ingest..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={2}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm sm:col-span-2"
            />
            <button
              type="submit"
              disabled={submit.isPending}
              className="self-end rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submit.isPending ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      )}

      <div className="flex gap-2">
        {["", "open", "resolved", "reopened"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
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
        <EmptyState title="No knowledge gaps" />
      ) : (
        <DataTable
          columns={[
            {
              key: "status",
              label: "Status",
              sortable: true,
              render: (row) => {
                const s = (row.status as string) || "open";
                const badge = STATUS_BADGES[s] ?? STATUS_BADGES.open!;
                return (
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                );
              },
            },
            { key: "query", label: "Query" },
            { key: "platform_context", label: "Domain", sortable: true },
            {
              key: "max_score",
              label: "Max Score",
              sortable: true,
              render: (r) =>
                (r.max_score as number).toFixed(3),
            },
            { key: "language", label: "Language" },
            {
              key: "timestamp",
              label: "Time",
              sortable: true,
              render: (r) => {
                const v = r.timestamp;
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
      )}
    </div>
  );
}
