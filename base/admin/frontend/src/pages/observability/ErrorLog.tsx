import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useFailures } from "../../api/hooks";
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
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : rows.length === 0 ? (
        <EmptyState title="No failures recorded" />
      ) : (
        <>
          <DataTable
            columns={[
              { key: "_id_short", label: "ID", className: "font-mono text-xs" },
              { key: "error_type", label: "Error Type", sortable: true },
              { key: "language", label: "Language", sortable: true },
              { key: "_task_short", label: "Task", className: "max-w-xs truncate" },
              { key: "_time", label: "Time", sortable: true },
            ]}
            data={rows}
            keyField="failure_id"
            onRowClick={(r) => navigate(`/observability/errors/${r.failure_id}`)}
          />
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
