import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { clsx } from "clsx";
import { useYarnSessionDetail, type YarnSessionRequestRow } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";

function truncId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function finishReasonIsError(reason: string | null | undefined): boolean {
  const r = (reason || "").toLowerCase();
  return r === "error" || r === "tool_loop_limit_exceeded";
}

export default function YarnSessionDetail() {
  const { sessionKey } = useParams<{ sessionKey: string }>();
  const navigate = useNavigate();
  const key = sessionKey ? decodeURIComponent(sessionKey) : "";
  const { data, isLoading, isError, error } = useYarnSessionDetail(key || undefined);

  if (!key) {
    return (
      <EmptyState title="Missing session" description="No session key in the URL." />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate("/yarn/sessions")}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <ArrowLeft className="h-4 w-4" />
          Sessions
        </button>
      </div>

      <ApiErrorBanner error={isError ? error : undefined} />

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : isError || !data ? (
        <EmptyState
          title="Session not found"
          description="The session may have been purged or the key is invalid."
        />
      ) : (
        <>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              Session
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-gray-500 dark:text-gray-400">
              {data.session.session_key}
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  User
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {data.session.username || data.session.user_id || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Role
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {data.session.role || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Provider / Model
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {(data.session.provider || "—") + " · " + (data.session.model || "—")}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Requests
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {data.session.request_count.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Tokens (in / out / cached)
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fmtTokens(data.session.total_tokens_in)} /{" "}
                  {fmtTokens(data.session.total_tokens_out)} /{" "}
                  {fmtTokens(data.session.total_tokens_cached)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Total cost
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fmtCost(data.session.total_cost_usd)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Escalations
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {data.session.escalation_count.toLocaleString()}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h2 className="mb-3 text-lg font-medium text-gray-900 dark:text-white">
              Requests
            </h2>
            {data.requests.length === 0 ? (
              <EmptyState title="No requests logged" description="Usage rows for this session are empty." />
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Request ID
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          In
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Out
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Cached
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Latency
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Cost
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Flags
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Finish
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Time
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                      {data.requests.map((rq: YarnSessionRequestRow) => (
                        <tr key={rq.id}>
                          <td
                            className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300"
                            title={rq.request_id}
                          >
                            {truncId(rq.request_id)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(rq.tokens_in)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(rq.tokens_out)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(rq.tokens_cached)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtDurationMs(rq.latency_ms)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtCost(rq.cost_usd)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            {rq.escalated ? (
                              <StatusBadge status="warning" label="Escalated" />
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={clsx(
                                finishReasonIsError(rq.finish_reason) && "font-medium text-red-600 dark:text-red-400",
                              )}
                            >
                              {rq.finish_reason || "—"}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600 dark:text-gray-400">
                            {rq.created_at
                              ? new Date(rq.created_at).toLocaleString()
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
