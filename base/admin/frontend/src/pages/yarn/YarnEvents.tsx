import { useState } from "react";
import { clsx } from "clsx";
import { useYarnEvents, type YarnEventRow } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function truncId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function isAlertEvent(e: YarnEventRow): boolean {
  if (e.escalated) return true;
  const fr = (e.finish_reason || "").toLowerCase();
  return ["error", "tool_loop_limit_exceeded", "escalated"].includes(fr);
}

function StatusCell({ row }: { row: YarnEventRow }) {
  const fr = row.finish_reason || "—";
  if (row.escalated) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge status="warning" label="Escalated" />
        <span className="text-gray-600 dark:text-gray-400">{fr}</span>
      </div>
    );
  }
  if (["error", "tool_loop_limit_exceeded"].includes((row.finish_reason || "").toLowerCase())) {
    return <StatusBadge status="error" label={fr} />;
  }
  return <span className="text-gray-700 dark:text-gray-300">{fr}</span>;
}

export default function YarnEvents() {
  const [sinceHours, setSinceHours] = useState(24);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data, isLoading, isError, error, isFetching } = useYarnEvents(
    page,
    pageSize,
    sinceHours,
    errorsOnly,
  );

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Events &amp; Errors
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Yarn usage log — filter to incidents or browse everything
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
            <button
              type="button"
              onClick={() => {
                setErrorsOnly(false);
                setPage(1);
              }}
              className={clsx(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                !errorsOnly
                  ? "bg-indigo-600 text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
              )}
            >
              All events
            </button>
            <button
              type="button"
              onClick={() => {
                setErrorsOnly(true);
                setPage(1);
              }}
              className={clsx(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                errorsOnly
                  ? "bg-indigo-600 text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
              )}
            >
              Errors only
            </button>
          </div>
          <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.hours}
                type="button"
                onClick={() => {
                  setSinceHours(opt.hours);
                  setPage(1);
                }}
                className={clsx(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  sinceHours === opt.hours
                    ? "bg-indigo-600 text-white"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ApiErrorBanner error={isError ? error : undefined} />

      {isLoading && !data ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : events.length === 0 ? (
        <EmptyState
          title="No events in this window"
          description={
            errorsOnly
              ? "No escalations or error finish reasons matched."
              : "No Yarn usage rows for the selected period."
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Time
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Request ID
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      User
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Provider
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Latency
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Tokens
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Cost
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Status / Finish
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                  {events.map((row) => (
                    <tr
                      key={row.id}
                      className={clsx(
                        isAlertEvent(row) && "bg-amber-50/60 dark:bg-amber-950/20",
                      )}
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600 dark:text-gray-400">
                        {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                      </td>
                      <td
                        className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300"
                        title={row.request_id}
                      >
                        {truncId(row.request_id)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-900 dark:text-gray-100">
                        {row.user_id || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-300">
                        {row.provider || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                        {fmtDurationMs(row.latency_ms)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                        {fmtTokens(row.tokens_in + row.tokens_out + row.tokens_cached)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                        {fmtCost(row.cost_usd)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusCell row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600 dark:text-gray-400">
            <span>
              {total.toLocaleString()} events · page {page} of {totalPages}
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
