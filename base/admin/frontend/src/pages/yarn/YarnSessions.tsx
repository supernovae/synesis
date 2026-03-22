import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";
import { useYarnSessions, type YarnSessionRow } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function truncKey(key: string): string {
  if (key.length <= 20) return key;
  return `${key.slice(0, 10)}…${key.slice(-6)}`;
}

export default function YarnSessions() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const { data, isLoading, isError, error, isFetching } = useYarnSessions(page, pageSize);

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function goRow(row: YarnSessionRow) {
    navigate(`/yarn/sessions/${encodeURIComponent(row.session_key)}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Yarn Sessions
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Agent sessions aggregated from Yarn usage
        </p>
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
                      Session Key
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Provider
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
                        <td
                          className="max-w-[200px] truncate px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300"
                          title={row.session_key}
                        >
                          {truncKey(row.session_key)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-300">
                          {row.provider || "—"}
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
