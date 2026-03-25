import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useBulkDeleteFailures, useDeleteFailure, useFailures, usePurgeFailures } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";

const ERROR_TYPE_CHIPS = ["", "graph_error", "timeout", "retrieval_timeout", "retrieval_error", "critic_error", "runtime", "lint", "security"];

function formatTimestamp(ts: string | number): string {
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (!n || isNaN(n)) return "—";
  return new Date(n * 1000).toLocaleString();
}

export default function ErrorLog() {
  const navigate = useNavigate();
  const [language, setLanguage] = useState("");
  const [errorType, setErrorType] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const delOne = useDeleteFailure();
  const delBulk = useBulkDeleteFailures();
  const purgeResolved = usePurgeFailures();
  const { data, isLoading } = useFailures({
    language: language || undefined,
    error_type: errorType || undefined,
    page,
    page_size: 20,
  });
  const failures = useMemo(() => data?.failures ?? [], [data]);

  const rows = useMemo(
    () =>
      failures.map((f) => ({
        ...f,
        _time: formatTimestamp(f.timestamp),
        _task_short: (f.task_description || "").slice(0, 120) || "—",
        _id_short: (f.failure_id || "").slice(0, 12),
      })),
    [failures],
  );
  const selectedIds = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected[r.failure_id]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Error Log</h1>
        <p className="mt-1 text-sm text-gray-500">
          Graph errors, retrieval timeouts, and failure patterns
        </p>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <input
          placeholder="Filter by language"
          value={language}
          onChange={(e) => { setLanguage(e.target.value); setPage(1); }}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
        <div className="flex flex-wrap gap-1">
          {ERROR_TYPE_CHIPS.map((t) => (
            <button
              key={t || "__all__"}
              onClick={() => { setErrorType(t); setPage(1); }}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                errorType === t
                  ? "bg-indigo-100 text-indigo-800 border-indigo-300"
                  : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
              }`}
            >
              {t || "All types"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            if (!selectedIds.length) return;
            if (!window.confirm(`Delete ${selectedIds.length} selected error(s)?`)) return;
            delBulk.mutate(selectedIds, { onSuccess: () => setSelected({}) });
          }}
          disabled={!selectedIds.length || delBulk.isPending}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50"
        >
          Delete selected
        </button>
        <button
          type="button"
          onClick={() => {
            if (!window.confirm("Purge resolved error history?")) return;
            purgeResolved.mutate(true);
          }}
          disabled={purgeResolved.isPending}
          className="rounded-md border border-amber-300 px-3 py-1.5 text-sm text-amber-800 disabled:opacity-50"
        >
          Purge resolved
        </button>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : rows.length === 0 ? (
        <EmptyState title="No failures recorded" />
      ) : (
        <>
          <DataTable
            columns={[
              {
                key: "_select",
                label: "",
                render: (r) => (
                  <input
                    type="checkbox"
                    checked={Boolean(selected[r.failure_id])}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setSelected((prev) => ({ ...prev, [r.failure_id]: e.target.checked }))
                    }
                  />
                ),
              },
              { key: "_id_short", label: "ID", className: "font-mono text-xs" },
              { key: "error_type", label: "Error Type", sortable: true },
              { key: "language", label: "Language", sortable: true },
              { key: "_task_short", label: "Task", className: "max-w-xs truncate" },
              { key: "_time", label: "Time", sortable: true },
              {
                key: "_actions",
                label: "Actions",
                render: (r) => (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm("Delete this error record?")) return;
                      delOne.mutate(String(r.failure_id));
                    }}
                    className="rounded px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    Delete
                  </button>
                ),
              },
            ]}
            data={rows}
            keyField="failure_id"
            onRowClick={(r) => navigate(`/observability/errors/${r.failure_id}`)}
          />
          <label className="flex items-center gap-2 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(e) => {
                const checked = e.target.checked;
                setSelected((prev) => {
                  const next = { ...prev };
                  for (const row of rows) next[row.failure_id] = checked;
                  return next;
                });
              }}
            />
            Select all visible
          </label>
          <div className="flex gap-2 items-center">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              Previous
            </button>
            <span className="py-1 text-sm text-gray-500">
              Page {page}{data?.total ? ` of ${Math.ceil(data.total / 20)}` : ""}
            </span>
            <button
              disabled={failures.length < 20}
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
