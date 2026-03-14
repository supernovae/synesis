import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFailures } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";

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
  const failures = data?.failures ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Error Log</h1>
        <p className="mt-1 text-sm text-gray-500">
          Failure patterns and RAG corpus gaps
        </p>
      </div>

      <div className="flex gap-3">
        <input
          placeholder="Filter by language"
          value={language}
          onChange={(e) => { setLanguage(e.target.value); setPage(1); }}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
        <input
          placeholder="Filter by error type"
          value={errorType}
          onChange={(e) => { setErrorType(e.target.value); setPage(1); }}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : failures.length === 0 ? (
        <EmptyState title="No failures recorded" />
      ) : (
        <>
          <DataTable
            columns={[
              { key: "failure_id", label: "ID", className: "font-mono text-xs" },
              { key: "language", label: "Language", sortable: true },
              { key: "error_type", label: "Error Type", sortable: true },
              { key: "task_description", label: "Task", className: "max-w-xs truncate" },
              { key: "timestamp", label: "Time", sortable: true },
            ]}
            data={failures}
            keyField="failure_id"
            onRowClick={(r) => navigate(`/observability/errors/${r.failure_id}`)}
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
