import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";
import { Archive, Trash2 } from "lucide-react";
import {
  useYarnSessions,
  useYarnSessionsArchive,
  useYarnSessionsBulkDelete,
  useYarnSessionsPurge,
  type YarnPurgeResult,
  type YarnSessionRow,
} from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { fmtTokens, fmtCost } from "../../lib/formatUsage";

function truncKey(key: string): string {
  if (key.length <= 20) return key;
  return `${key.slice(0, 10)}…${key.slice(-6)}`;
}

const TIME_RANGES = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
  { label: "All", hours: 8760 },
] as const;

export default function YarnSessions() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [sinceHours, setSinceHours] = useState(168);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cleanupDays, setCleanupDays] = useState(90);
  const pageSize = 20;
  const { data, isLoading, isError, error, isFetching } = useYarnSessions(page, pageSize, sinceHours);
  const archiveSessions = useYarnSessionsArchive();
  const deleteSessions = useYarnSessionsBulkDelete();
  const purgeSessions = useYarnSessionsPurge();

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const visibleKeys = new Set(sessions.map((row) => row.session_key));
  const allSelected = visibleKeys.size > 0 && [...visibleKeys].every((key) => selected.has(key));
  const selectedKeys = [...selected];
  const latestCleanup: YarnPurgeResult | undefined = archiveSessions.data ?? purgeSessions.data;

  function goRow(row: YarnSessionRow) {
    navigate(`/yarn/sessions/${encodeURIComponent(row.session_key)}`);
  }

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const key of visibleKeys) next.delete(key);
        return next;
      }
      return new Set([...prev, ...visibleKeys]);
    });
  }

  function archiveSelected(deleteAfterArchive: boolean) {
    if (selectedKeys.length === 0) return;
    if (deleteAfterArchive && !confirm(`Archive and delete ${selectedKeys.length} selected Coder session(s)?`)) return;
    archiveSessions.mutate(
      { session_keys: selectedKeys, dry_run: false, delete_after_archive: deleteAfterArchive },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  function deleteSelected() {
    if (selectedKeys.length === 0) return;
    if (!confirm(`Delete ${selectedKeys.length} selected Coder session(s) from the live DB?`)) return;
    deleteSessions.mutate(selectedKeys, { onSuccess: () => setSelected(new Set()) });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Coder sessions
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Agent sessions aggregated from Coder usage
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
          {TIME_RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              onClick={() => { setSinceHours(r.hours); setPage(1); }}
              className={clsx(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                sinceHours === r.hours
                  ? "bg-blue-600 text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-2">
          {selectedKeys.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => archiveSelected(false)}
                disabled={archiveSessions.isPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 px-3 py-1.5 font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950"
              >
                <Archive className="h-3.5 w-3.5" />
                Archive {selectedKeys.length}
              </button>
              <button
                type="button"
                onClick={() => archiveSelected(true)}
                disabled={archiveSessions.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                <Archive className="h-3.5 w-3.5" />
                Archive + delete
              </button>
              <button
                type="button"
                onClick={deleteSelected}
                disabled={deleteSessions.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">Cleanup older than</span>
          <select
            value={cleanupDays}
            onChange={(e) => setCleanupDays(Number(e.target.value))}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
          <button
            type="button"
            onClick={() => purgeSessions.mutate({ older_than_days: cleanupDays, dry_run: true, archive_before_delete: true })}
            disabled={purgeSessions.isPending}
            className="rounded-md border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
          >
            Dry run
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirm(`Archive and purge Coder sessions older than ${cleanupDays} days?`)) return;
              purgeSessions.mutate({ older_than_days: cleanupDays, dry_run: false, archive_before_delete: true });
            }}
            disabled={purgeSessions.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5" />
            Archive + purge
          </button>
        </div>
      </div>

      {latestCleanup && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {latestCleanup.dry_run ? (
            <>
              Found <strong>{latestCleanup.sessions}</strong> old session(s),{" "}
              <strong>{latestCleanup.usage_rows}</strong> usage rows, and{" "}
              <strong>{latestCleanup.events}</strong> event rows eligible for cleanup.
            </>
          ) : (
            <>
              Archived {latestCleanup.archive?.record_count ?? 0} record(s)
              {latestCleanup.archive?.key ? ` to ${latestCleanup.archive.key}` : ""}.
              {latestCleanup.deleted ? ` Deleted ${latestCleanup.deleted.sessions} session(s).` : ""}
            </>
          )}
        </div>
      )}

      <ApiErrorBanner error={isError ? error : undefined} />
      <ApiErrorBanner error={archiveSessions.error ?? deleteSessions.error ?? purgeSessions.error ?? undefined} />

      {isLoading && !data ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : sessions.length === 0 ? (
        <EmptyState title="No sessions found" description="Try a different time range or wait for Coder API traffic." />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      User
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Client
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Conversation
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Model
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Requests
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Tokens
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Cache Saved
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Saved (Reduction)
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" title="Effective Cost (Actual if available, else Estimated)">
                      Cost
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Last Active
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                  {sessions.map((row) => {
                    // Fixed: cached is subset of total_tokens_in per OpenAI semantics; do not double-count in display.
                    // This addresses the unusually consistent low cached numbers in UI (now relies on accurate vLLM usage).
                    const tok = row.total_tokens_in + row.total_tokens_out;
                    return (
                      <tr
                        key={row.id}
                        onClick={() => goRow(row)}
                        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900"
                      >
                        <td className="whitespace-nowrap px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(row.session_key)}
                            onChange={() => toggleOne(row.session_key)}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-900 dark:text-gray-100">
                          <span title={row.user_id}>{row.user_display || row.username || row.user_id || "—"}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-300">
                          {row.client_kind || "—"}
                        </td>
                        <td
                          className="max-w-[160px] truncate px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300"
                          title={row.conversation_id ?? undefined}
                        >
                          {row.conversation_id ? truncKey(row.conversation_id) : "—"}
                        </td>
                        <td
                          className="max-w-[160px] truncate px-4 py-3 text-gray-700 dark:text-gray-300"
                          title={row.model ?? undefined}
                        >
                          {row.model || "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {row.request_count.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtTokens(tok)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-indigo-700 dark:text-indigo-300">
                          {fmtTokens(row.total_tokens_cached)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-green-600 dark:text-green-400">
                          {row.total_tokens_saved ? fmtTokens(row.total_tokens_saved) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400" title={`Actual: ${fmtCost(row.total_actual_cost_usd)} | Est: ${fmtCost(row.total_estimated_cost_usd)}`}>
                          {fmtCost(row.total_actual_cost_usd > 0 ? row.total_actual_cost_usd : row.total_estimated_cost_usd)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600 dark:text-gray-400">
                          {row.last_active_at
                            ? new Date(row.last_active_at).toLocaleString()
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600 dark:text-gray-400">
            <span>
              Page {page} of {totalPages}
              {isFetching ? " · Updating…" : ""}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className={clsx(
                  "rounded-lg border px-3 py-1.5 font-medium",
                  page <= 1
                    ? "cursor-not-allowed border-gray-200 text-gray-400 dark:border-gray-700"
                    : "border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800",
                )}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className={clsx(
                  "rounded-lg border px-3 py-1.5 font-medium",
                  page >= totalPages
                    ? "cursor-not-allowed border-gray-200 text-gray-400 dark:border-gray-700"
                    : "border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800",
                )}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
