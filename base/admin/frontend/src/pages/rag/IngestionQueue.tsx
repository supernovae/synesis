import { useState, useRef } from "react";
import {
  useIngestionStats,
  useIngestionItems,
  useIngestionRuns,
  useAddIngestionItem,
  useAddIngestionItemsBulk,
  useDeleteIngestionItem,
  useRetryIngestionItem,
  useBootstrapIngestion,
  useIngestionHandlers,
  useSchemaSync,
  useResetMilvusCatalog,
} from "../../api/hooks";
import { useAuth } from "../../components/auth/useAuth";
import { apiErrorMessage } from "../../api/errorMessage";
import type { HandlerMetadata } from "../../api/hooks";
import type { IngestionItem, IngestionRun, IndexerIngestionStats } from "../../types";

function numConfig(cfg: Record<string, unknown> | null, key: string, fallback: number): number {
  if (!cfg) return fallback;
  const v = cfg[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function CrawlViz({ item }: { item: IngestionItem }) {
  const handler = item.handler || "";
  const stats = item.indexer_stats as IndexerIngestionStats | null | undefined;
  const cfg = item.config;

  if (handler === "web_page") {
    const pages = typeof stats?.source_pages === "number" ? stats.source_pages : null;
    const maxPages =
      typeof stats?.planned_max_pages === "number"
        ? stats.planned_max_pages
        : Math.max(1, numConfig(cfg, "max_pages", 80));
    const maxDepth =
      typeof stats?.planned_max_depth === "number"
        ? stats.planned_max_depth
        : Math.max(0, numConfig(cfg, "max_depth", 4));
    const reached = typeof stats?.max_depth_reached === "number" ? stats.max_depth_reached : null;
    const discovery =
      (typeof stats?.discovery === "string" && stats.discovery) ||
      (typeof cfg?.discovery === "string" && cfg.discovery) ||
      "sitemap_first";
    const pct = pages != null && maxPages > 0 ? Math.min(100, (pages / maxPages) * 100) : 0;
    const title = `discovery: ${discovery}`;

    return (
      <div className="min-w-[128px] max-w-[180px]" title={title}>
        {pages != null ? (
          <>
            <div className="h-1.5 w-full rounded bg-gray-200 dark:bg-slate-600 overflow-hidden">
              <div
                className="h-full rounded bg-indigo-500 dark:bg-indigo-400 transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[10px] leading-tight text-gray-500 dark:text-gray-400 mt-0.5">
              {pages}/{maxPages} pages
              {reached != null
                ? ` · depth ${reached}/${maxDepth}`
                : item.status === "pending"
                  ? ` · cap ${maxDepth}d`
                  : ""}
            </div>
          </>
        ) : (
          <div className="text-[10px] leading-tight text-gray-500 dark:text-gray-400">
            ≤{maxPages} pg · cap {maxDepth}d · {discovery}
          </div>
        )}
      </div>
    );
  }

  if (stats && typeof stats.source_pages === "number") {
    return (
      <span className="text-xs text-gray-600 dark:text-gray-400" title={stats.handler}>
        {stats.source_pages} source{stats.source_pages === 1 ? "" : "s"}
      </span>
    );
  }
  return <span className="text-gray-400 dark:text-gray-500">—</span>;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  indexed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  complete_with_errors: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status] || "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"}`}>
      {status}
    </span>
  );
}

function SchemaUpgradeBanner() {
  const { data } = useSchemaSync();
  if (!data || !data.upgrade_pending) return null;

  const sync = data.syncs[0];
  const currentVersion = sync?.schema_version ?? 0;
  const expectedVersion = data.expected_version;
  const lastReported = sync?.updated_at
    ? new Date(sync.updated_at).toLocaleString()
    : "never";
  const neverReported = currentVersion === 0;

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-900/20">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-amber-600 dark:text-amber-400 text-lg">&#9888;</span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Schema Upgrade Pending {neverReported ? "" : `(v${currentVersion} → v${expectedVersion})`}
          </h3>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {neverReported ? (
              <>
                No schema version has been reported yet. The indexer needs to run to initialize
                the Milvus collection at <strong>v{expectedVersion}</strong> and report back.
              </>
            ) : (
              <>
                The deployed code expects schema <strong>v{expectedVersion}</strong> but Milvus
                is still on <strong>v{currentVersion}</strong>. The indexer will automatically
                drop and recreate the collection, then reset all items to pending for re-indexing.
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            Last reported: {lastReported}
            {sync?.last_reported_by && <> by <strong>{sync.last_reported_by}</strong></>}
          </p>
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Items shown below as "indexed" are stale and will be reset once the indexer starts.
          </p>
        </div>
      </div>
    </div>
  );
}

function StatsBar() {
  const { data } = useIngestionStats();
  if (!data) return null;
  const cards = [
    { label: "Total Items", value: data.total_items, color: "text-gray-900 dark:text-white" },
    { label: "Pending", value: data.pending, color: "text-yellow-600 dark:text-yellow-400" },
    { label: "Running", value: data.running, color: "text-blue-600 dark:text-blue-400" },
    { label: "Indexed", value: data.indexed, color: "text-green-600 dark:text-green-400" },
    { label: "Failed", value: data.failed, color: "text-red-600 dark:text-red-400" },
    { label: "Total Chunks", value: data.total_chunks.toLocaleString(), color: "text-gray-900 dark:text-white" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">{c.label}</div>
          <div className={`text-xl font-semibold ${c.color}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function AddItemForm() {
  const addItem = useAddIngestionItem();
  const addBulk = useAddIngestionItemsBulk();
  const bootstrap = useBootstrapIngestion();
  const { data: handlersData } = useIngestionHandlers();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uri, setUri] = useState("");
  const [handler, setHandler] = useState("html_document");
  const [domain, setDomain] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [tab, setTab] = useState<"single" | "bulk" | "file">("single");

  const handlers: HandlerMetadata[] = handlersData?.handlers ?? [];
  const selectedHandler = handlers.find((h) => h.handler_type === handler);
  const uriHint = selectedHandler?.uri_hint ?? "Enter a URI";

  const handleSingle = () => {
    if (!uri.trim()) return;
    addItem.mutate({ uri: uri.trim(), handler, domain: domain || undefined });
    setUri("");
  };

  const handleBulk = () => {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    addBulk.mutate({
      items: lines.map((line) => ({ uri: line, handler, domain: domain || undefined })),
    });
    setBulkText("");
  };

  const handleFile = () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    bootstrap.mutate({ file: f, status_override: "pending" });
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 mb-6">
      <div className="flex gap-2 mb-3">
        {(["single", "bulk", "file"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded text-sm font-medium ${tab === t ? "bg-indigo-600 text-white" : "bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300"}`}
          >
            {t === "single" ? "Add URI" : t === "bulk" ? "Bulk Paste" : "Upload YAML"}
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-2">
        <select
          value={handler}
          onChange={(e) => setHandler(e.target.value)}
          className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-2 py-1 text-sm"
        >
          {handlers.length > 0
            ? handlers.map((h) => (
                <option key={h.handler_type} value={h.handler_type}>
                  {h.label}
                </option>
              ))
            : (
                <option value="html_document">HTML Document</option>
              )}
        </select>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="domain (optional)"
          className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-2 py-1 text-sm w-40"
        />
      </div>

      {selectedHandler && (
        <div className="flex items-center gap-3 mb-3 text-xs text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center rounded bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 font-mono">
            {selectedHandler.artifact_kind}
          </span>
          <span>URI pattern: <code className="text-gray-600 dark:text-gray-300">{selectedHandler.uri_pattern}</code></span>
          {Object.keys(selectedHandler.config_hints).length > 0 && (
            <span>Config: <code className="text-gray-600 dark:text-gray-300">{JSON.stringify(selectedHandler.config_hints)}</code></span>
          )}
        </div>
      )}

      {tab === "single" && (
        <div className="flex gap-2">
          <input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSingle()}
            placeholder={uriHint}
            className="flex-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-3 py-1.5 text-sm"
          />
          <button
            onClick={handleSingle}
            disabled={addItem.isPending}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {tab === "bulk" && (
        <div>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={`Paste one URI per line (${uriHint})`}
            rows={5}
            className="w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-3 py-2 text-sm font-mono mb-2"
          />
          <button
            onClick={handleBulk}
            disabled={addBulk.isPending}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            Add {bulkText.split("\n").filter((l) => l.trim()).length} URIs
          </button>
        </div>
      )}

      {tab === "file" && (
        <div className="flex gap-2 items-center">
          <input ref={fileRef} type="file" accept=".yaml,.yml,.json" className="text-sm text-gray-700 dark:text-gray-300" />
          <button
            onClick={handleFile}
            disabled={bootstrap.isPending}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {bootstrap.isPending ? "Importing..." : "Import"}
          </button>
          {bootstrap.data && (
            <span className="text-sm text-green-600 dark:text-green-400">
              Added {(bootstrap.data as Record<string, number>).added}, skipped {(bootstrap.data as Record<string, number>).skipped}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ItemsTable() {
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useIngestionItems({ status: statusFilter || undefined, page, page_size: 30 });
  const deleteItem = useDeleteIngestionItem();
  const retryItem = useRetryIngestionItem();

  const items = data?.items || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / 30);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden mb-6">
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Items ({total})
        </h3>
        <div className="flex gap-2">
          {["", "pending", "running", "indexed", "failed"].map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`px-2 py-0.5 rounded text-xs font-medium ${statusFilter === s ? "bg-indigo-600 text-white" : "bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300"}`}
            >
              {s || "All"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-gray-500 dark:text-gray-400">Loading...</div>
      ) : items.length === 0 ? (
        <div className="p-6 text-center text-gray-500 dark:text-gray-400">No items found</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <th className="px-3 py-2">URI</th>
                <th className="px-3 py-2">Handler</th>
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Crawl</th>
                <th className="px-3 py-2 text-right">Chunks</th>
                <th className="px-3 py-2">Error</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {items.map((item: IngestionItem) => (
                <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="px-3 py-2 max-w-xs truncate text-gray-900 dark:text-white font-mono text-xs" title={item.uri}>
                    {item.title || item.uri}
                  </td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{item.handler || "—"}</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{item.domain || "—"}</td>
                  <td className="px-3 py-2"><StatusBadge status={item.status} /></td>
                  <td className="px-3 py-2 align-top"><CrawlViz item={item} /></td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{item.chunk_count || "—"}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate text-red-600 dark:text-red-400 text-xs" title={item.error_message}>
                    {item.error_message || ""}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {item.status === "failed" && item.retry_count < item.max_retries && (
                      <button
                        onClick={() => retryItem.mutate(item.id)}
                        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mr-2"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={() => deleteItem.mutate(item.id)}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-slate-700">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="text-xs text-gray-600 dark:text-gray-400 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="text-xs text-gray-600 dark:text-gray-400 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function ResetCatalogPanel() {
  const { isAdmin } = useAuth();
  const reset = useResetMilvusCatalog();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [resetQueue, setResetQueue] = useState(true);

  if (!isAdmin) return null;

  return (
    <div className="mt-8 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 p-4">
      <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">Danger zone — Milvus catalog</h3>
      <p className="mt-1 text-xs text-red-700 dark:text-red-400">
        Drop <code className="rounded bg-red-100 dark:bg-red-900/40 px-1">synesis_catalog</code> and optionally reset
        all ingestion items to pending. The indexer will recreate the collection on its next run (v9 schema).
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-200"
        >
          Open reset flow…
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={resetQueue}
              onChange={(e) => setResetQueue(e.target.checked)}
            />
            Also reset indexed/failed items to pending
          </label>
          <input
            type="text"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder='Type DELETE_SYNESIS_CATALOG to confirm'
            className="block w-full max-w-md rounded border border-red-200 px-2 py-1 text-sm dark:border-red-900 dark:bg-slate-900 dark:text-white"
          />
          {reset.isError ? (
            <p className="text-xs text-red-600">{apiErrorMessage(reset.error)}</p>
          ) : null}
          {reset.isSuccess ? (
            <p className="text-xs text-green-700 dark:text-green-400">
              Catalog dropped. Items reset: {String((reset.data as { items_reset?: number })?.items_reset ?? 0)}.
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={reset.isPending || phrase !== "DELETE_SYNESIS_CATALOG"}
              onClick={() =>
                reset.mutate(
                  { confirm: "DELETE_SYNESIS_CATALOG", reset_queue: resetQueue },
                  {
                    onSuccess: () => {
                      setPhrase("");
                      setOpen(false);
                    },
                  },
                )
              }
              className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-40"
            >
              {reset.isPending ? "Working…" : "Drop catalog"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPhrase("");
                reset.reset();
              }}
              className="text-xs text-gray-600 dark:text-gray-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunsHistory() {
  const { data } = useIngestionRuns();
  const runs = data?.runs || [];
  if (!runs.length) return null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
      <div className="p-3 border-b border-gray-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Run History</h3>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-700">
        {runs.map((run: IngestionRun) => {
          const pct = run.items_total > 0 ? Math.round(((run.items_indexed + run.items_failed) / run.items_total) * 100) : 0;
          return (
            <div key={run.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <StatusBadge status={run.status} />
              <span className="text-gray-600 dark:text-gray-400 text-xs">{run.trigger}</span>
              <div className="flex-1">
                <div className="h-1.5 rounded bg-gray-200 dark:bg-slate-600 overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400 w-32 text-right">
                {run.items_indexed}/{run.items_total} indexed
                {run.items_failed > 0 && `, ${run.items_failed} failed`}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500 w-28 text-right">
                {run.started_at ? new Date(run.started_at).toLocaleDateString() : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function IngestionQueue() {
  return (
    <div className="space-y-0">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Ingestion Queue</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Add content to index. Items are claimed by the indexer and processed into the Milvus corpus.
        </p>
      </div>
      <SchemaUpgradeBanner />
      <StatsBar />
      <AddItemForm />
      <ItemsTable />
      <RunsHistory />
      <ResetCatalogPanel />
    </div>
  );
}
