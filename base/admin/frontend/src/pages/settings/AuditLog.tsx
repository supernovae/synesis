import { useMemo, useState } from "react";
import { useAdminAuditEvents, type AdminAuditEventRow } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";
import { ChevronDown, ChevronRight, RefreshCw, ScrollText } from "lucide-react";

function statusStyle(status: string): string {
  switch (status) {
    case "success":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  }
}

function EventRow({ row }: { row: AdminAuditEventRow }) {
  const [open, setOpen] = useState(false);
  const hasDetail = row.detail && Object.keys(row.detail).length > 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <button
        type="button"
        onClick={() => hasDetail && setOpen(!open)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        {hasDetail ? (
          open ? (
            <ChevronDown className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
          )
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${statusStyle(row.status)}`}
            >
              {row.status}
            </span>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {row.source}
            </span>
            <span className="font-mono text-xs text-indigo-600 dark:text-indigo-400">{row.action}</span>
          </div>
          <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">{row.summary}</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {row.actor_username || row.actor_user_id || "—"}
            {row.actor_role ? ` · ${row.actor_role}` : ""}
          </p>
        </div>
      </button>
      {open && hasDetail && (
        <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-800">
          <pre className="max-h-64 overflow-auto rounded bg-gray-50 p-3 font-mono text-[11px] text-gray-700 dark:bg-gray-950 dark:text-gray-300">
            {JSON.stringify(row.detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function AuditLog() {
  const { data, isLoading, isFetching, refetch } = useAdminAuditEvents(200);
  const events = useMemo(() => data?.events ?? [], [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-900 dark:text-white">
            <ScrollText className="h-7 w-7 text-indigo-500" />
            Admin audit
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">
            Rolling history of model registry changes, direct route updates, provider key updates, and
            cost settings. Expand a row for JSON detail such as assignment payloads and sync results. Secrets are
            never stored here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : events.length === 0 ? (
        <EmptyState
          title="No audit events yet"
          description="Actions from the admin API will appear here after you change models, refresh routes, or update provider keys."
        />
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <EventRow key={e.id} row={e} />
          ))}
        </div>
      )}
    </div>
  );
}
