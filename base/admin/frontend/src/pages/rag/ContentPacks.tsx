import { useMemo, useState } from "react";
import {
  useContentPacks,
  useInstallContentPack,
  useRetryContentPackInstallJob,
  type ContentPackEntry,
} from "../../api/hooks";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import EmptyState from "../../components/common/EmptyState";
import { AlertTriangle, ChevronDown, ChevronUp, Download, RefreshCw, RotateCcw } from "lucide-react";

function formatBytes(value: number) {
  if (!value) return "Unknown";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatCount(value?: number) {
  if (!value) return "0";
  return new Intl.NumberFormat().format(value);
}

function formatScore(value?: number) {
  if (value === undefined || value === null || value < 0) return "n/a";
  return value <= 1 ? `${Math.round(value * 100)}%` : value.toFixed(2);
}

function statusTone(status: string) {
  if (status === "installed") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200";
  if (status === "update_available") return "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200";
  if (status === "failed" || status === "dead_letter") return "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200";
  if (status === "running") return "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200";
  return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200";
}

function PackStatus({ pack }: { pack: ContentPackEntry }) {
  const status = pack.install_status || "not_installed";
  const label = status === "update_available" ? "Update available" : status.replace("_", " ");
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${statusTone(status)}`}>
      {label}
    </span>
  );
}

function JobRow({ job, onRetry }: { job: { id: number; pack_id: string; pack_version: string; status: string; attempt_count: number; max_attempts: number; requested_by: string; error_message?: string }; onRetry: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = Boolean(job.error_message);

  return (
    <tr>
      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
        {job.pack_id}@{job.pack_version || "unversioned"}
      </td>
      <td className="px-4 py-3">
        <span className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${statusTone(job.status)}`}>
          {job.status.replace("_", " ")}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
        {job.attempt_count}/{job.max_attempts}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{job.requested_by || "system"}</td>
      <td className="max-w-xl px-4 py-3 text-sm text-red-700 dark:text-red-300">
        {hasError && (
          <div>
            <div className={expanded ? "whitespace-pre-wrap break-all" : "truncate"} title={job.error_message}>
              {job.error_message}
            </div>
            {job.error_message!.length > 80 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200"
              >
                {expanded ? <><ChevronUp className="h-3 w-3" /> Collapse</> : <><ChevronDown className="h-3 w-3" /> Show full error</>}
              </button>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {job.status !== "running" && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:text-blue-900 dark:text-blue-300"
          >
            <RotateCcw className="h-4 w-4" /> Retry
          </button>
        )}
      </td>
    </tr>
  );
}

export default function ContentPacks() {
  const { data, isLoading, error, refetch, isFetching } = useContentPacks();
  const installPack = useInstallContentPack();
  const retryJob = useRetryContentPackInstallJob();
  const [replaceByPack, setReplaceByPack] = useState<Record<string, boolean>>({});
  const degradedWarnings = data?.warnings ?? data?.catalog?.warnings ?? [];

  const latestJobByPack = useMemo(() => {
    const out: Record<string, string> = {};
    for (const job of data?.jobs ?? []) {
      if (!out[job.pack_id]) out[job.pack_id] = job.status;
    }
    return out;
  }, [data?.jobs]);

  const queueInstall = (pack: ContentPackEntry) => {
    installPack.mutate({
      pack_id: pack.pack_id,
      version: pack.version,
      replace: Boolean(replaceByPack[pack.pack_id] ?? pack.install_status !== "not_installed"),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Content Packs</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Install hosted Synesis RAG packs into the NornicDB content graph.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <ApiErrorBanner error={error || installPack.error || retryJob.error} />

      {degradedWarnings.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <div>
            <div className="font-medium">Showing partial content pack data</div>
            <div className="mt-1">
              {degradedWarnings.map((warning) => warning.message).join(" ")}
            </div>
          </div>
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Catalog</h2>
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          <div className="font-medium">{data?.catalog?.name || "Synesis Content Packs"}</div>
          <div className="mt-1 break-all text-xs text-gray-500 dark:text-gray-400">
            {data?.config?.catalog_url || "https://r2.kybern.dev/synesis-pack-catalog.json"}
          </div>
          {data?.config?.using_default && (
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Using the built-in Synesis catalog.</div>
          )}
        </div>
        {(data?.catalog?.errors ?? []).length > 0 && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            {data?.catalog.errors.join("; ")}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Available Packs</h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">{data?.catalog?.packs?.length ?? 0} listed</span>
        </div>
        {isLoading ? (
          <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
        ) : (data?.catalog?.packs ?? []).length === 0 ? (
          <EmptyState
            title="No content packs available"
            description={
              data?.degraded
                ? "The catalog or NornicDB summary is temporarily unavailable. Installed packs and jobs will remain visible when available."
                : "The default Synesis content pack catalog returned no packs."
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {data?.catalog.packs.map((pack) => {
              const latestStatus = latestJobByPack[pack.pack_id];
              const busy = latestStatus === "pending" || latestStatus === "running" || installPack.isPending;
              return (
                <div
                  key={`${pack.pack_id}:${pack.version}`}
                  className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">{pack.name}</h3>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {pack.pack_id}@{pack.version || "unversioned"} - {formatBytes(pack.size_bytes)}
                      </p>
                    </div>
                    <PackStatus pack={pack} />
                  </div>
                  <p className="mt-3 line-clamp-3 text-sm text-gray-600 dark:text-gray-300">
                    {pack.description || "No description provided."}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {[pack.domain, pack.language, ...(pack.tags ?? [])].filter(Boolean).slice(0, 6).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      >
                        {tag}
                      </span>
                    ))}
                    {pack.install_profile && (
                      <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                        {pack.install_profile}
                      </span>
                    )}
                    {pack.requires_bulk_import && (
                      <span className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                        bulk import
                      </span>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <div>{formatCount(pack.node_count)} nodes</div>
                    <div>{formatCount(pack.edge_count)} edges</div>
                  </div>
                  {(pack.quality || pack.example_count || pack.context_card_count || pack.anti_pattern_count) && (
                    <div className="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
                      <div className="grid grid-cols-2 gap-2">
                        <div>{formatCount(pack.quality?.example_count ?? pack.example_count)} examples</div>
                        <div>{formatCount(pack.quality?.context_card_count ?? pack.context_card_count)} cards</div>
                        <div>{formatCount(pack.quality?.anti_pattern_count ?? pack.anti_pattern_count)} anti-patterns</div>
                        <div>{formatCount(pack.quality?.constraint_count)} constraints</div>
                        <div>{formatScore(pack.quality?.freshness_score ?? pack.freshness_score)} freshness</div>
                        <div>{formatScore(pack.quality?.quality_score ?? pack.quality_score)} quality</div>
                        <div>{formatScore(pack.quality?.trust_score ?? pack.trust_score)} trust</div>
                        <div>{formatCount(pack.quality?.external_ref_count)} refs</div>
                      </div>
                      {pack.quality?.node_kind_counts && Object.keys(pack.quality.node_kind_counts).length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 font-medium text-gray-700 dark:text-gray-200">Node mix</div>
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(pack.quality.node_kind_counts).slice(0, 10).map(([kind, count]) => (
                              <span key={kind} className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">
                                {kind}:{formatCount(count)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {pack.quality?.edge_type_counts && Object.keys(pack.quality.edge_type_counts).length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 font-medium text-gray-700 dark:text-gray-200">Graph edges</div>
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(pack.quality.edge_type_counts).slice(0, 10).map(([kind, count]) => (
                              <span key={kind} className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                                {kind}:{formatCount(count)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={Boolean(replaceByPack[pack.pack_id] ?? pack.install_status !== "not_installed")}
                        onChange={(e) => setReplaceByPack({ ...replaceByPack, [pack.pack_id]: e.target.checked })}
                      />
                      Replace installed pack
                    </label>
                    <button
                      onClick={() => queueInstall(pack)}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" /> Install
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Install Jobs</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Pending jobs are claimed by the <span className="font-mono">synesis-indexer-content-packs</span> CronJob.
          </p>
        </div>
        {(data?.jobs ?? []).length === 0 ? (
          <div className="p-5">
            <EmptyState title="No install jobs yet" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800/80">
                <tr>
                  {["Pack", "Status", "Attempts", "Requested", "Error", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {data?.jobs.map((job) => (
                  <JobRow key={job.id} job={job} onRetry={() => retryJob.mutate(job.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
