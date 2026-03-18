import { useState, useRef } from "react";
import {
  useIngestionStats,
  useIngestionItems,
  useIngestionSources,
  useIngestionRuns,
  useAddIngestionItem,
  useAddIngestionItemsBulk,
  useDeleteIngestionItem,
  useRetryIngestionItem,
  useBootstrapIngestion,
  useCreateIngestionSource,
} from "../../api/hooks";
import type { IngestionItem, IngestionRun } from "../../types";

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
  const fileRef = useRef<HTMLInputElement>(null);
  const [uri, setUri] = useState("");
  const [handler, setHandler] = useState("html_document");
  const [domain, setDomain] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [tab, setTab] = useState<"single" | "bulk" | "file">("single");

  const handlers = [
    "html_document", "web_page", "pdf_document", "github_code",
    "github_markdown", "arxiv_paper", "openapi_spec", "license_spdx",
  ];

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

      <div className="flex gap-2 mb-3">
        <select
          value={handler}
          onChange={(e) => setHandler(e.target.value)}
          className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-2 py-1 text-sm"
        >
          {handlers.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="domain (optional)"
          className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-2 py-1 text-sm w-40"
        />
      </div>

      {tab === "single" && (
        <div className="flex gap-2">
          <input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSingle()}
            placeholder="https://... or gs://... or gdrive://..."
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
            placeholder="Paste one URI per line..."
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
      <StatsBar />
      <AddItemForm />
      <ItemsTable />
      <RunsHistory />
    </div>
  );
}
