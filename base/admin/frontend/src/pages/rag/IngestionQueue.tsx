import { useState, useRef } from "react";
import {
  useIngestionStats,
  useIngestionItems,
  useIngestionRuns,
  useAddIngestionItem,
  useAddIngestionItemsBulk,
  useDeleteIngestionItem,
  useRetryIngestionItem,
  usePatchIngestionItem,
  useRequeueIngestionItem,
  useDiscoverUrl,
  useBootstrapIngestion,
  useIngestionHandlers,
  useSchemaSync,
  useResetMilvusCatalog,
  useRerunStagedItem,
  useRecoverStaleIngestionLeases,
  useStagedItemDocuments,
  useEditStagedDocument,
} from "../../api/hooks";
import type { DiscoveryResult } from "../../api/hooks";
import { useAuth } from "../../components/auth/useAuth";
import { apiErrorMessage } from "../../api/errorMessage";
import type { HandlerMetadata } from "../../api/hooks";
import type { IngestionItem, IngestionRun, IndexerIngestionStats, StagedIngestionDocument } from "../../types";

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
  dead_letter: "bg-gray-200 text-gray-800 dark:bg-slate-600 dark:text-gray-200",
  staged_raw: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/30 dark:text-cyan-200",
  staged_norm: "bg-teal-100 text-teal-900 dark:bg-teal-900/30 dark:text-teal-200",
  enrich_queued: "bg-violet-100 text-violet-900 dark:bg-violet-900/30 dark:text-violet-200",
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
    { label: "Dead letter", value: data.dead_letter ?? 0, color: "text-gray-600 dark:text-gray-400" },
    { label: "Staged raw", value: data.staged_raw ?? 0, color: "text-cyan-600 dark:text-cyan-400" },
    { label: "Staged norm", value: data.staged_norm ?? 0, color: "text-teal-600 dark:text-teal-400" },
    { label: "Enrich queued", value: data.enrich_queued ?? 0, color: "text-violet-600 dark:text-violet-400" },
    { label: "Doc rows", value: data.staged_documents ?? 0, color: "text-gray-700 dark:text-gray-300" },
    { label: "Enrich Q", value: data.enrich_queue_pending ?? 0, color: "text-violet-600 dark:text-violet-400" },
    { label: "Semantic items", value: data.semantic_contract_items ?? 0, color: "text-indigo-600 dark:text-indigo-400" },
    { label: "Pass-B chunks", value: data.semantic_chunks_enriched ?? 0, color: "text-indigo-600 dark:text-indigo-400" },
    { label: "Full enrich items", value: data.enrich_full_items ?? 0, color: "text-indigo-600 dark:text-indigo-400" },
    { label: "Total Chunks", value: data.total_chunks.toLocaleString(), color: "text-gray-900 dark:text-white" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 mb-6">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">{c.label}</div>
          <div className={`text-xl font-semibold ${c.color}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function DiscoveryReview({ result, onEnqueue, onCancel, isPending }: {
  result: DiscoveryResult;
  onEnqueue: (data: { uri: string; handler: string; title: string; domain: string; tags: string[]; config: Record<string, unknown> }) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [title, setTitle] = useState(result.title);
  const [handler, setHandler] = useState(result.handler);
  const [domain, setDomain] = useState(result.domain);
  const [tags, setTags] = useState(result.tags.join(", "));
  const [configText, setConfigText] = useState(JSON.stringify(result.config, null, 2));

  const save = () => {
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configText || "{}");
    } catch {
      window.alert("Config must be valid JSON.");
      return;
    }
    onEnqueue({
      uri: result.url,
      handler,
      title,
      domain,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      config: parsedConfig,
    });
  };

  return (
    <div className="mt-3 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/10 p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">Discovery result</h4>
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${result.recommended_mode === "batch" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"}`}>
          {result.recommended_mode}
        </span>
      </div>

      {result.risk_flags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {result.risk_flags.map((f) => (
            <span key={f} className="text-xs rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-1.5 py-0.5">{f}</span>
          ))}
        </div>
      )}
      {result.notes && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{result.notes}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs mb-3">
        <label className="block">
          <span className="text-gray-600 dark:text-gray-300">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
        </label>
        <label className="block">
          <span className="text-gray-600 dark:text-gray-300">Handler</span>
          <input value={handler} onChange={(e) => setHandler(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
        </label>
        <label className="block">
          <span className="text-gray-600 dark:text-gray-300">Domain</span>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
        </label>
        <label className="block">
          <span className="text-gray-600 dark:text-gray-300">Tags</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
        </label>
      </div>
      <label className="block text-xs mb-3">
        <span className="text-gray-600 dark:text-gray-300">Config (JSON)</span>
        <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} rows={6} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm font-mono" />
      </label>

      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded text-xs text-gray-700 dark:text-gray-300">Cancel</button>
        <button onClick={save} disabled={isPending} className="px-4 py-1.5 rounded bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50">
          {isPending ? "Adding…" : "Enqueue"}
        </button>
      </div>
    </div>
  );
}

function AddItemForm() {
  const addItem = useAddIngestionItem();
  const addBulk = useAddIngestionItemsBulk();
  const bootstrap = useBootstrapIngestion();
  const discover = useDiscoverUrl();
  const { data: handlersData } = useIngestionHandlers();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uri, setUri] = useState("");
  const [handler, setHandler] = useState("html_document");
  const [domain, setDomain] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [tab, setTab] = useState<"single" | "bulk" | "file">("single");
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [useLlm, setUseLlm] = useState(false);

  const handlers: HandlerMetadata[] = handlersData?.handlers ?? [];
  const selectedHandler = handlers.find((h) => h.handler_type === handler);
  const uriHint = selectedHandler?.uri_hint ?? "Enter a URI";

  const handleSingle = () => {
    if (!uri.trim()) return;
    addItem.mutate({ uri: uri.trim(), handler, domain: domain || undefined }, {
      onSuccess: () => setUri(""),
    });
  };

  const handleDiscover = () => {
    if (!uri.trim()) return;
    discover.mutate({ url: uri.trim(), use_llm: useLlm }, {
      onSuccess: (data) => setDiscoveryResult(data),
    });
  };

  const handleEnqueue = (data: { uri: string; handler: string; title: string; domain: string; tags: string[]; config: Record<string, unknown> }) => {
    addItem.mutate(data, {
      onSuccess: () => {
        setDiscoveryResult(null);
        setUri("");
      },
    });
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
            onClick={() => { setTab(t); setDiscoveryResult(null); }}
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

      {tab === "single" && !discoveryResult && (
        <div>
          <div className="flex gap-2">
            <input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSingle()}
              placeholder={uriHint}
              className="flex-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white px-3 py-1.5 text-sm"
            />
            <button
              onClick={handleDiscover}
              disabled={discover.isPending || !uri.trim()}
              className="px-4 py-1.5 rounded bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50"
            >
              {discover.isPending ? "Discovering…" : "Discover"}
            </button>
            <button
              onClick={handleSingle}
              disabled={addItem.isPending}
              className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <label className="flex items-center gap-1.5 mt-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />
            Use LLM enrichment during discovery
          </label>
        </div>
      )}

      {tab === "single" && discover.isError && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{apiErrorMessage(discover.error)}</p>
      )}

      {tab === "single" && discoveryResult && (
        <DiscoveryReview
          result={discoveryResult}
          onEnqueue={handleEnqueue}
          onCancel={() => setDiscoveryResult(null)}
          isPending={addItem.isPending}
        />
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

const ADMIN_STATUSES = ["pending", "failed", "dead_letter", "indexed", "staged_raw", "staged_norm", "enrich_queued"];

function EditItemModal({ item, onClose }: { item: IngestionItem; onClose: () => void }) {
  const patchItem = usePatchIngestionItem();
  const [title, setTitle] = useState(item.title || "");
  const [handler, setHandler] = useState(item.handler || "");
  const [domain, setDomain] = useState(item.domain || "");
  const [authority, setAuthority] = useState(item.authority || "vetted");
  const [originType, setOriginType] = useState(item.origin_type || "curated");
  const [tags, setTags] = useState((item.tags || []).join(", "));
  const [priority, setPriority] = useState(item.priority ?? 0);
  const [configText, setConfigText] = useState(JSON.stringify(item.config || {}, null, 2));
  const [status, setStatus] = useState(item.status);

  const save = () => {
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configText || "{}");
    } catch {
      window.alert("Config must be valid JSON.");
      return;
    }
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    patchItem.mutate(
      {
        itemId: item.id,
        title,
        handler: handler || undefined,
        domain,
        authority,
        origin_type: originType,
        tags: tagList,
        priority,
        config: parsedConfig,
        status: status !== item.status ? status : undefined,
      },
      { onSuccess: onClose },
    );
  };

  const cfg = item.config as Record<string, unknown> | null;
  const isWeb = (item.handler || "").includes("web");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900">
        <h5 className="text-sm font-semibold text-gray-900 dark:text-white">
          Edit item {item.id}
        </h5>
        <p className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-1 truncate" title={item.uri}>
          {item.uri}
        </p>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
          </label>
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Handler</span>
            <input value={handler} onChange={(e) => setHandler(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
          </label>
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Domain</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
          </label>
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Priority</span>
            <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
          </label>
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Authority</span>
            <select value={authority} onChange={(e) => setAuthority(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm">
              <option value="canonical">canonical</option>
              <option value="vetted">vetted</option>
              <option value="community">community</option>
              <option value="untrusted">untrusted</option>
            </select>
          </label>
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Origin type</span>
            <select value={originType} onChange={(e) => setOriginType(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm">
              <option value="curated">curated</option>
              <option value="official">official</option>
              <option value="community">community</option>
              <option value="generated">generated</option>
            </select>
          </label>
          <label className="block">
            <span className="text-gray-600 dark:text-gray-300">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm">
              {ADMIN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <label className="block mt-3 text-xs">
          <span className="text-gray-600 dark:text-gray-300">Tags (comma-separated)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
        </label>

        {isWeb && (
          <div className="mt-3 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 p-3">
            <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300 mb-2">Crawl shortcuts</p>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">max_pages</span>
                <input
                  type="number"
                  defaultValue={cfg?.max_pages != null ? Number(cfg.max_pages) : 80}
                  onChange={(e) => {
                    try {
                      const c = JSON.parse(configText || "{}");
                      c.max_pages = Number(e.target.value);
                      setConfigText(JSON.stringify(c, null, 2));
                    } catch { /* user will fix in JSON editor */ }
                  }}
                  className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">max_depth</span>
                <input
                  type="number"
                  defaultValue={cfg?.max_depth != null ? Number(cfg.max_depth) : 4}
                  onChange={(e) => {
                    try {
                      const c = JSON.parse(configText || "{}");
                      c.max_depth = Number(e.target.value);
                      setConfigText(JSON.stringify(c, null, 2));
                    } catch { /* user will fix in JSON editor */ }
                  }}
                  className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">discovery</span>
                <select
                  defaultValue={(cfg?.discovery as string) || "sitemap_first"}
                  onChange={(e) => {
                    try {
                      const c = JSON.parse(configText || "{}");
                      c.discovery = e.target.value;
                      setConfigText(JSON.stringify(c, null, 2));
                    } catch { /* user will fix in JSON editor */ }
                  }}
                  className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm"
                >
                  <option value="sitemap_first">sitemap_first</option>
                  <option value="sitemap_only">sitemap_only</option>
                  <option value="bfs">bfs</option>
                </select>
              </label>
            </div>
          </div>
        )}

        <label className="block mt-3 text-xs">
          <span className="text-gray-600 dark:text-gray-300">Config (JSON)</span>
          <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} rows={8} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm font-mono" />
        </label>

        {patchItem.isError && (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">{apiErrorMessage(patchItem.error)}</div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-xs text-gray-700 dark:text-gray-300">
            Cancel
          </button>
          <button
            disabled={patchItem.isPending}
            onClick={save}
            className="px-3 py-1.5 rounded bg-indigo-600 text-white text-xs disabled:opacity-50"
          >
            {patchItem.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ItemsTable() {
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [editingItem, setEditingItem] = useState<IngestionItem | null>(null);
  const { data, isLoading } = useIngestionItems({ status: statusFilter || undefined, page, page_size: 30 });
  const deleteItem = useDeleteIngestionItem();
  const retryItem = useRetryIngestionItem();
  const requeueItem = useRequeueIngestionItem();

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
          {["", "pending", "running", "indexed", "failed", "dead_letter", "staged_raw", "staged_norm", "enrich_queued"].map((s) => (
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
                    <button
                      onClick={() => setEditingItem(item)}
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mr-2"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setSelectedItemId(item.id)}
                      className="text-xs text-gray-600 dark:text-gray-300 hover:underline mr-2"
                    >
                      Docs
                    </button>
                    {item.status === "failed" && item.retry_count < item.max_retries && (
                      <button
                        onClick={() => retryItem.mutate(item.id)}
                        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mr-2"
                      >
                        Retry
                      </button>
                    )}
                    {item.status === "dead_letter" && (
                      <button
                        onClick={() => {
                          if (window.confirm("Reset retry counter and requeue this dead_letter item?")) {
                            requeueItem.mutate({ itemId: item.id, reset_retries: true });
                          }
                        }}
                        className="text-xs text-amber-600 dark:text-amber-400 hover:underline mr-2"
                      >
                        Requeue
                      </button>
                    )}
                    {item.status === "indexed" && (
                      <button
                        onClick={() => requeueItem.mutate({ itemId: item.id })}
                        className="text-xs text-cyan-600 dark:text-cyan-400 hover:underline mr-2"
                      >
                        Re-run
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

      <StagedLifecyclePanel
        itemId={selectedItemId}
        onClose={() => setSelectedItemId(null)}
      />

      {editingItem && (
        <EditItemModal
          item={editingItem}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  );
}

function StagedLifecyclePanel({ itemId, onClose }: { itemId: number | null; onClose: () => void }) {
  const rerun = useRerunStagedItem();
  const recover = useRecoverStaleIngestionLeases();
  const editDoc = useEditStagedDocument();
  const { data, isLoading, refetch } = useStagedItemDocuments(itemId);
  const [editingDoc, setEditingDoc] = useState<StagedIngestionDocument | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDomain, setDraftDomain] = useState("");
  const [draftAuthority, setDraftAuthority] = useState("vetted");
  const [draftOriginType, setDraftOriginType] = useState("curated");
  const [draftTags, setDraftTags] = useState("");
  const [draftConfig, setDraftConfig] = useState("{}");

  if (!itemId) return null;

  const docs: StagedIngestionDocument[] = data?.documents ?? [];

  const rerunPhase = (phase: "all" | "fetch" | "normalize" | "enrich") => {
    rerun.mutate({ itemId, phase, reset_retries: true });
  };

  const startEdit = (d: StagedIngestionDocument) => {
    setEditingDoc(d);
    setDraftTitle(d.title || "");
    setDraftDomain(d.domain || "");
    setDraftAuthority(d.authority || "vetted");
    setDraftOriginType(d.origin_type || "curated");
    setDraftTags((d.tags || []).join(", "));
    const cfg = d.config_snapshot && typeof d.config_snapshot === "object" ? d.config_snapshot : {};
    setDraftConfig(JSON.stringify(cfg, null, 2));
  };

  const saveEdit = () => {
    if (!editingDoc) return;
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(draftConfig || "{}");
    } catch {
      window.alert("Config snapshot must be valid JSON.");
      return;
    }
    const tags = draftTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    editDoc.mutate(
      {
        documentId: editingDoc.id,
        title: draftTitle,
        domain: draftDomain,
        authority: draftAuthority,
        origin_type: draftOriginType,
        tags,
        config_snapshot: parsedConfig,
      },
      {
        onSuccess: () => {
          setEditingDoc(null);
          void refetch();
        },
      },
    );
  };

  return (
    <div className="border-t border-gray-200 dark:border-slate-700 p-3 bg-gray-50 dark:bg-slate-900/30">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
          Item {itemId} lifecycle controls
        </h4>
        <button onClick={onClose} className="text-xs text-gray-600 dark:text-gray-300 hover:underline">
          Close
        </button>
      </div>
      <div className="flex gap-2 mt-2 flex-wrap">
        <button disabled={rerun.isPending} onClick={() => rerunPhase("all")} className="px-2 py-1 rounded bg-indigo-600 text-white text-xs disabled:opacity-50">Rerun all</button>
        <button disabled={rerun.isPending} onClick={() => rerunPhase("fetch")} className="px-2 py-1 rounded bg-cyan-600 text-white text-xs disabled:opacity-50">Rerun fetch</button>
        <button disabled={rerun.isPending} onClick={() => rerunPhase("normalize")} className="px-2 py-1 rounded bg-teal-600 text-white text-xs disabled:opacity-50">Rerun normalize</button>
        <button disabled={rerun.isPending} onClick={() => rerunPhase("enrich")} className="px-2 py-1 rounded bg-violet-600 text-white text-xs disabled:opacity-50">Rerun enrich</button>
        <button
          disabled={recover.isPending}
          onClick={() => recover.mutate({ stale_minutes: 30 })}
          className="px-2 py-1 rounded bg-gray-700 text-white text-xs disabled:opacity-50"
        >
          Recover stale leases
        </button>
        <button
          onClick={() => void refetch()}
          className="px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 text-xs"
        >
          Refresh docs
        </button>
      </div>
      {rerun.isError ? (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400">{apiErrorMessage(rerun.error)}</div>
      ) : null}
      {rerun.isSuccess ? (
        <div className="mt-2 text-xs text-green-700 dark:text-green-400">Phase rerun request accepted.</div>
      ) : null}
      {recover.isError ? (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400">{apiErrorMessage(recover.error)}</div>
      ) : null}
      {recover.isSuccess ? (
        <div className="mt-2 text-xs text-green-700 dark:text-green-400">
          Recovered stale leases:{" "}
          {String((recover.data as { items_recovered?: number })?.items_recovered ?? 0)} items,{" "}
          {String((recover.data as { documents_recovered?: number })?.documents_recovered ?? 0)} docs,{" "}
          {String((recover.data as { enrich_jobs_recovered?: number })?.enrich_jobs_recovered ?? 0)} jobs.
        </div>
      ) : null}
      {isLoading ? (
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-3">Loading staged documents...</div>
      ) : docs.length === 0 ? (
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-3">No staged documents for this item.</div>
      ) : (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <th className="py-1 pr-2">Doc</th>
                <th className="py-1 pr-2">Raw</th>
                <th className="py-1 pr-2">Norm</th>
                <th className="py-1 pr-2">Enrich</th>
                <th className="py-1 pr-2 text-right">Chunks</th>
                <th className="py-1 pr-2">Error</th>
                <th className="py-1 pr-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {docs.slice(0, 25).map((d) => (
                <tr key={d.id}>
                  <td className="py-1 pr-2 max-w-[360px] truncate" title={d.canonical_uri}>{d.title || d.canonical_uri}</td>
                  <td className="py-1 pr-2">{d.raw_status}</td>
                  <td className="py-1 pr-2">{d.norm_status}</td>
                  <td className="py-1 pr-2">{d.enrich_status}</td>
                  <td className="py-1 pr-2 text-right">{d.chunk_count || 0}</td>
                  <td className="py-1 pr-2 max-w-[220px] truncate text-red-600 dark:text-red-400" title={d.error_message}>{d.error_message || "—"}</td>
                  <td className="py-1 pr-2 text-right">
                    <button
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                      onClick={() => startEdit(d)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editingDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-2xl rounded-lg bg-white p-4 shadow-xl dark:bg-slate-900">
            <h5 className="text-sm font-semibold text-gray-900 dark:text-white">
              Edit document {editingDoc.id}
            </h5>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">Title</span>
                <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
              </label>
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">Domain</span>
                <input value={draftDomain} onChange={(e) => setDraftDomain(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
              </label>
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">Authority</span>
                <select value={draftAuthority} onChange={(e) => setDraftAuthority(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm">
                  <option value="canonical">canonical</option>
                  <option value="vetted">vetted</option>
                  <option value="community">community</option>
                  <option value="untrusted">untrusted</option>
                </select>
              </label>
              <label className="block">
                <span className="text-gray-600 dark:text-gray-300">Origin type</span>
                <select value={draftOriginType} onChange={(e) => setDraftOriginType(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm">
                  <option value="curated">curated</option>
                  <option value="official">official</option>
                  <option value="community">community</option>
                  <option value="generated">generated</option>
                </select>
              </label>
            </div>
            <label className="block mt-3 text-xs">
              <span className="text-gray-600 dark:text-gray-300">Tags (comma-separated)</span>
              <input value={draftTags} onChange={(e) => setDraftTags(e.target.value)} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm" />
            </label>
            <label className="block mt-3 text-xs">
              <span className="text-gray-600 dark:text-gray-300">Config snapshot (JSON)</span>
              <textarea value={draftConfig} onChange={(e) => setDraftConfig(e.target.value)} rows={8} className="mt-1 w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm font-mono" />
            </label>
            {editDoc.isError ? (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400">{apiErrorMessage(editDoc.error)}</div>
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setEditingDoc(null)}
                className="px-3 py-1.5 rounded text-xs text-gray-700 dark:text-gray-300"
              >
                Cancel
              </button>
              <button
                disabled={editDoc.isPending}
                onClick={saveEdit}
                className="px-3 py-1.5 rounded bg-indigo-600 text-white text-xs disabled:opacity-50"
              >
                {editDoc.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
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
