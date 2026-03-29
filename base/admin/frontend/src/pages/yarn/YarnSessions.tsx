import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";
import { useYarnSessions, type YarnSessionRow } from "../../api/hooks";
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
  const pageSize = 20;
  const { data, isLoading, isError, error, isFetching } = useYarnSessions(page, pageSize, sinceHours);

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function goRow(row: YarnSessionRow) {
    navigate(`/yarn/sessions/${encodeURIComponent(row.session_key)}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Yarn Sessions
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Agent sessions aggregated from Yarn usage
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

      <ApiErrorBanner error={isError ? error : undefined} />

      {isLoading && !data ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : sessions.length === 0 ? (
        <EmptyState title="No sessions found" description="Try a different time range or wait for Yarn traffic." />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
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
                      Saved
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Cost
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Last Active
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                  {sessions.map((row) => {
                    const tok =
                      row.total_tokens_in + row.total_tokens_out + row.total_tokens_cached;
                    return (
                      <tr
                        key={row.id}
                        onClick={() => goRow(row)}
                        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900"
                      >
                        <td className="whitespace-nowrap px-4 py-3 text-gray-900 dark:text-gray-100">
                          {row.username || row.user_id || "—"}
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
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-green-600 dark:text-green-400">
                          {row.total_tokens_saved ? fmtTokens(row.total_tokens_saved) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtCost(row.total_cost_usd)}
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
