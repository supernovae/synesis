import { useState } from "react";
import { clsx } from "clsx";
import { PlayCircle, RefreshCw } from "lucide-react";
import { useYarnHealth, useYarnVerify, type YarnVerifyCheck } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

export default function YarnVerification() {
  const {
    data: health,
    isLoading: healthLoading,
    refetch,
    isFetching,
    isError: healthQueryError,
    error: healthError,
  } = useYarnHealth();
  const verifyMutation = useYarnVerify();
  const [dismissHealthErr, setDismissHealthErr] = useState(false);
  const [dismissVerifyErr, setDismissVerifyErr] = useState(false);

  const checks: YarnVerifyCheck[] = verifyMutation.data?.checks ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Verification
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Live health probe and on-demand smoke checks against the Yarn service
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setDismissHealthErr(false);
              void refetch();
            }}
            disabled={healthLoading || isFetching}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <RefreshCw className={clsx("h-4 w-4", isFetching && "animate-spin")} />
            Refresh health
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissVerifyErr(false);
              verifyMutation.mutate();
            }}
            disabled={verifyMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            {verifyMutation.isPending ? "Running…" : "Run verification"}
          </button>
        </div>
      </div>

      {!dismissHealthErr && healthQueryError ? (
        <ApiErrorBanner error={healthError} onDismiss={() => setDismissHealthErr(true)} />
      ) : null}

      {healthLoading && !health ? (
        <div className="h-32 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : health ? (
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Yarn service health
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <StatusBadge
              status={health.status === "ok" ? "healthy" : "error"}
              label={health.status === "ok" ? "Reachable" : "Unreachable"}
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">{health.name}</span>
            {health.status_code != null && (
              <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400">
                HTTP {health.status_code}
              </span>
            )}
            <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400">
              {health.latency_ms != null ? `${health.latency_ms.toFixed(1)} ms` : "—"}
            </span>
          </div>
          {health.error && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{health.error}</p>
          )}
        </div>
      ) : null}

      <ApiErrorBanner
        error={!dismissVerifyErr && verifyMutation.isError ? verifyMutation.error : undefined}
        onDismiss={() => setDismissVerifyErr(true)}
      />

      {/* Include isError: otherwise a failed POST hides the panel and checks never appear. */}
      {(verifyMutation.isSuccess || verifyMutation.isPending || verifyMutation.isError) && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Verification run
            </h2>
            {verifyMutation.isSuccess && verifyMutation.data && (
              <StatusBadge
                status={verifyMutation.data.overall === "pass" ? "healthy" : "error"}
                label={verifyMutation.data.overall === "pass" ? "All checks passed" : "Some checks failed"}
              />
            )}
            {verifyMutation.isPending && (
              <span className="text-sm text-gray-500 dark:text-gray-400">Running checks…</span>
            )}
            {verifyMutation.isError && (
              <StatusBadge status="error" label="Request failed" />
            )}
          </div>

          {verifyMutation.isError && checks.length === 0 ? (
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
              The admin API could not run verification (see error above). If Yarn pods are down or{" "}
              <code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">SYNESIS_YARN_URL</code> is wrong,
              fix the deployment and try again.
            </p>
          ) : null}

          {checks.length > 0 && (
            <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
              {checks.map((c) => (
                <li key={c.check} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0">
                  <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{c.check}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={c.status === "pass" ? "healthy" : "error"}
                      label={c.status}
                    />
                    {c.status_code != null && (
                      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                        HTTP {c.status_code}
                      </span>
                    )}
                    {c.error && (
                      <span className="max-w-md text-xs text-red-600 dark:text-red-400">{c.error}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
