import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Loader2,
  Info,
  CheckSquare,
  Square,
  MinusSquare,
  Clock,
  ArrowUpDown,
  Filter,
} from "lucide-react";
import client from "../../api/client";
import RichContent from "../../components/common/RichContent";

interface FlagReason {
  id: string;
  label: string;
}

interface ReviewChunk {
  chunk_id: string;
  doc_id: string;
  document_name: string;
  source_url: string;
  authority: string;
  origin_type: string;
  domain: string;
  scan_status: string;
  heading_path: string;
  text_preview: string;
  flag_reasons: FlagReason[];
  content_format?: string;
  symbol_type?: string;
  approval_status?: string;
  scan_signals?: string;
  review_trace_id?: string;
  effective_at_epoch?: number;
  crawl_timestamp?: number;
  freshness_score?: number;
}

interface ReviewStats {
  flagged: number;
  unscanned: number;
  pending_approval: number;
}

const STATUS_BADGE: Record<string, string> = {
  flagged:
    "bg-red-100 text-red-700 border border-red-200 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30",
  unscanned:
    "bg-yellow-100 text-yellow-700 border border-yellow-200 dark:bg-yellow-500/20 dark:text-yellow-400 dark:border-yellow-500/30",
  vetted:
    "bg-green-100 text-green-700 border border-green-200 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30",
  clean:
    "bg-green-100 text-green-700 border border-green-200 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30",
  pending:
    "bg-orange-100 text-orange-700 border border-orange-200 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-500/30",
};

const AUTHORITY_BADGE: Record<string, string> = {
  vetted:
    "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  canonical:
    "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  community:
    "bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300",
  external:
    "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

type SortPivot = "" | "freshness" | "authority" | "scan_status";

function formatFreshness(score?: number): { label: string; color: string } {
  if (score === undefined || score === null || score <= 0)
    return { label: "Unknown", color: "text-gray-400 dark:text-slate-500" };
  if (score >= 0.8)
    return { label: "Fresh", color: "text-green-600 dark:text-green-400" };
  if (score >= 0.5)
    return { label: "Recent", color: "text-blue-600 dark:text-blue-400" };
  if (score >= 0.2)
    return { label: "Aging", color: "text-yellow-600 dark:text-yellow-400" };
  return { label: "Stale", color: "text-orange-600 dark:text-orange-400" };
}

function formatEpoch(epoch?: number): string {
  if (!epoch || epoch <= 0) return "";
  return new Date(epoch * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ReviewQueue() {
  const [chunks, setChunks] = useState<ReviewChunk[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [filter, setFilter] = useState<"flagged" | "unscanned" | "all">(
    "flagged",
  );
  const [sortPivot, setSortPivot] = useState<SortPivot>("");
  const [domainFilter, setDomainFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const [confirmBulkReject, setConfirmBulkReject] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        status: filter,
        limit: 100,
      };
      if (sortPivot) params.sort = sortPivot;
      if (domainFilter) params.domain = domainFilter;
      const [statsRes, chunkRes] = await Promise.all([
        client.get("/rag/review/stats").then((r) => r.data),
        client.get("/rag/review", { params }).then((r) => r.data),
      ]);
      setStats(statsRes);
      setChunks(chunkRes.chunks || []);
      setSelected(new Set());
    } catch {
      setChunks([]);
    } finally {
      setLoading(false);
    }
  }, [filter, sortPivot, domainFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function toggleSelect(chunkId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) next.delete(chunkId);
      else next.add(chunkId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === chunks.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(chunks.map((c) => c.chunk_id)));
    }
  }

  async function handleAction(chunkId: string, action: "vet" | "reject") {
    setActing(chunkId);
    setConfirmReject(null);
    try {
      await client.post(`/rag/review/${chunkId}/${action}`);
      setChunks((prev) => prev.filter((c) => c.chunk_id !== chunkId));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(chunkId);
        return next;
      });
      if (stats) {
        const key = chunks.find((c) => c.chunk_id === chunkId)
          ?.scan_status as keyof ReviewStats;
        if (key && typeof stats[key] === "number" && stats[key] > 0)
          setStats({ ...stats, [key]: stats[key] - 1 });
      }
    } finally {
      setActing(null);
    }
  }

  async function handleBulkAction(action: "vet" | "reject") {
    if (selected.size === 0) return;
    setBulkActing(true);
    setConfirmBulkReject(false);
    try {
      await client.post(`/rag/review/bulk/${action}`, {
        chunk_ids: Array.from(selected),
      });
      setChunks((prev) =>
        prev.filter((c) => !selected.has(c.chunk_id)),
      );
      setSelected(new Set());
      if (stats) {
        const updated = { ...stats };
        for (const c of chunks) {
          if (selected.has(c.chunk_id)) {
            const key = c.scan_status as keyof ReviewStats;
            if (key && typeof updated[key] === "number" && updated[key] > 0)
              updated[key] = updated[key] - 1;
          }
        }
        setStats(updated);
      }
    } finally {
      setBulkActing(false);
    }
  }

  const allSelected = chunks.length > 0 && selected.size === chunks.length;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Review Queue
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Chunks flagged by index-time injection scanning or awaiting
          approval. Select multiple chunks for bulk actions.
        </p>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-slate-800">
            <ShieldAlert className="h-4 w-4 text-red-500 dark:text-red-400" />
            <span className="text-sm text-gray-700 dark:text-slate-300">
              {stats.flagged} flagged
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-slate-800">
            <ShieldCheck className="h-4 w-4 text-yellow-500 dark:text-yellow-400" />
            <span className="text-sm text-gray-700 dark:text-slate-300">
              {stats.unscanned} unscanned
            </span>
          </div>
          {stats.pending_approval > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-slate-800">
              <Info className="h-4 w-4 text-orange-500 dark:text-orange-400" />
              <span className="text-sm text-gray-700 dark:text-slate-300">
                {stats.pending_approval} pending approval
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            {(["flagged", "unscanned", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === f
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:text-gray-900 dark:bg-slate-800 dark:text-slate-400 dark:hover:text-white"
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <ArrowUpDown className="h-3.5 w-3.5 text-gray-400 dark:text-slate-500" />
            <select
              value={sortPivot}
              onChange={(e) => setSortPivot(e.target.value as SortPivot)}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700 dark:border-gray-600 dark:bg-slate-800 dark:text-slate-300"
            >
              <option value="">Default order</option>
              <option value="freshness">Freshness (newest)</option>
              <option value="authority">Authority tier</option>
              <option value="scan_status">Scan status</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-gray-400 dark:text-slate-500" />
            <input
              type="text"
              value={domainFilter}
              onChange={(e) => setDomainFilter(e.target.value)}
              placeholder="Filter domain..."
              className="w-36 rounded-md border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700 placeholder-gray-400 dark:border-gray-600 dark:bg-slate-800 dark:text-slate-300 dark:placeholder-slate-500"
            />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-slate-400">
              {selected.size} selected
            </span>
            <button
              disabled={bulkActing}
              onClick={() => handleBulkAction("vet")}
              className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {bulkActing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              Approve All
            </button>
            {confirmBulkReject ? (
              <div className="flex items-center gap-1">
                <button
                  disabled={bulkActing}
                  onClick={() => handleBulkAction("reject")}
                  className="flex items-center gap-1 rounded-md bg-red-600 px-2 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm Reject
                </button>
                <button
                  onClick={() => setConfirmBulkReject(false)}
                  className="rounded-md px-2 py-1.5 text-sm text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                disabled={bulkActing}
                onClick={() => setConfirmBulkReject(true)}
                className="flex items-center gap-1 rounded-md bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-600/20 dark:text-red-400 dark:hover:bg-red-600/30"
              >
                <Trash2 className="h-3.5 w-3.5" /> Reject All
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-slate-400" />
        </div>
      ) : chunks.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-slate-800/50">
          <ShieldCheck className="mx-auto h-8 w-8 text-green-500 dark:text-green-400" />
          <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">
            No chunks need review.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Select all header */}
          <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-slate-800/30">
            <button onClick={toggleSelectAll} className="text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white">
              {allSelected ? (
                <CheckSquare className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              ) : someSelected ? (
                <MinusSquare className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              ) : (
                <Square className="h-5 w-5" />
              )}
            </button>
            <span className="text-sm text-gray-500 dark:text-slate-400">
              {allSelected
                ? "All selected"
                : someSelected
                  ? `${selected.size} of ${chunks.length} selected`
                  : "Select all"}
            </span>
          </div>

          {chunks.map((chunk) => (
            <div
              key={chunk.chunk_id}
              className={`rounded-lg border bg-white p-4 transition-colors dark:bg-slate-800/50 ${
                selected.has(chunk.chunk_id)
                  ? "border-blue-300 bg-blue-50/30 dark:border-blue-600/50 dark:bg-blue-900/10"
                  : "border-gray-200 dark:border-gray-700"
              }`}
            >
              <div className="flex items-start gap-3">
                {/* Checkbox */}
                <button
                  onClick={() => toggleSelect(chunk.chunk_id)}
                  className="mt-0.5 flex-shrink-0 text-gray-400 hover:text-gray-900 dark:text-slate-500 dark:hover:text-white"
                >
                  {selected.has(chunk.chunk_id) ? (
                    <CheckSquare className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  ) : (
                    <Square className="h-5 w-5" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  {/* Status badges */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[chunk.scan_status] || STATUS_BADGE.unscanned}`}
                    >
                      {chunk.scan_status}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${AUTHORITY_BADGE[chunk.authority] || AUTHORITY_BADGE.community}`}
                    >
                      {chunk.authority}
                    </span>
                    {chunk.domain && (
                      <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                        {chunk.domain}
                      </span>
                    )}
                    {chunk.content_format && (
                      <span className="rounded bg-purple-50 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                        {chunk.content_format}
                      </span>
                    )}
                    {chunk.symbol_type && (
                      <span className="rounded bg-cyan-50 px-2 py-0.5 text-xs text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300">
                        {chunk.symbol_type}
                      </span>
                    )}
                    {chunk.approval_status && chunk.approval_status !== "auto_approved" && (
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[chunk.approval_status] || STATUS_BADGE.pending}`}
                      >
                        {chunk.approval_status}
                      </span>
                    )}
                  </div>

                  {/* Flag reasons */}
                  {chunk.flag_reasons && chunk.flag_reasons.length > 0 && (
                    <div className="mt-2 flex items-start gap-1.5">
                      <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500 dark:text-red-400" />
                      <div className="flex flex-wrap gap-1">
                        {chunk.flag_reasons.map((reason) => (
                          <span
                            key={reason.id}
                            className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300"
                            title={reason.id}
                          >
                            {reason.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Trust attribution metadata */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {chunk.freshness_score !== undefined && chunk.freshness_score > 0 && (
                      <span
                        className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${formatFreshness(chunk.freshness_score).color}`}
                        title={`Freshness: ${Math.round(chunk.freshness_score * 100)}%`}
                      >
                        <Clock className="h-3 w-3" />
                        {formatFreshness(chunk.freshness_score).label}
                      </span>
                    )}
                    {chunk.effective_at_epoch && chunk.effective_at_epoch > 0 && (
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-400">
                        Content: {formatEpoch(chunk.effective_at_epoch)}
                      </span>
                    )}
                    {chunk.crawl_timestamp && chunk.crawl_timestamp > 0 && (
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-400">
                        Crawled: {formatEpoch(chunk.crawl_timestamp)}
                      </span>
                    )}
                    {chunk.review_trace_id && (
                      <span
                        className="rounded bg-violet-50 px-2 py-0.5 text-xs text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                        title={chunk.review_trace_id}
                      >
                        Reviewed
                      </span>
                    )}
                    {chunk.scan_signals && chunk.scan_signals.length > 0 && (
                      <span
                        className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400"
                        title={`Scan signals: ${chunk.scan_signals}`}
                      >
                        {typeof chunk.scan_signals === "string"
                          ? chunk.scan_signals.split(",").length
                          : 0}{" "}
                        signal(s)
                      </span>
                    )}
                  </div>

                  {/* Document name and heading */}
                  <p className="mt-2 text-sm font-medium text-gray-900 dark:text-slate-200">
                    {chunk.document_name || chunk.doc_id}
                  </p>
                  {chunk.heading_path && (
                    <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
                      {chunk.heading_path}
                    </p>
                  )}

                  {/* Content preview */}
                  <RichContent content={chunk.text_preview} maxHeight="max-h-48" className="mt-2" />

                  {chunk.source_url && (
                    <a
                      href={chunk.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {chunk.source_url}
                    </a>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex flex-shrink-0 flex-col gap-2">
                  <button
                    disabled={acting === chunk.chunk_id}
                    onClick={() => handleAction(chunk.chunk_id, "vet")}
                    className="flex items-center gap-1 rounded-md bg-green-100 px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-200 disabled:opacity-50 dark:bg-green-600/20 dark:text-green-400 dark:hover:bg-green-600/30"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Approve
                  </button>
                  {confirmReject === chunk.chunk_id ? (
                    <div className="flex items-center gap-1">
                      <button
                        disabled={acting === chunk.chunk_id}
                        onClick={() =>
                          handleAction(chunk.chunk_id, "reject")
                        }
                        className="flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmReject(null)}
                        className="rounded-md px-2 py-1 text-xs text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      disabled={acting === chunk.chunk_id}
                      onClick={() => setConfirmReject(chunk.chunk_id)}
                      className="flex items-center gap-1 rounded-md bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-600/20 dark:text-red-400 dark:hover:bg-red-600/30"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Reject
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
