import { useState, useEffect, useCallback } from "react";
import { ShieldAlert, ShieldCheck, Trash2, Loader2, Info } from "lucide-react";
import client from "../../api/client";

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
}

interface ReviewStats {
  flagged: number;
  unscanned: number;
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
};

const AUTHORITY_BADGE: Record<string, string> = {
  vetted: "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  canonical: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  community: "bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300",
  external: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

export default function ReviewQueue() {
  const [chunks, setChunks] = useState<ReviewChunk[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [filter, setFilter] = useState<"flagged" | "unscanned" | "all">(
    "flagged",
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, chunkRes] = await Promise.all([
        client.get("/rag/review/stats").then((r) => r.data),
        client
          .get("/rag/review", { params: { status: filter, limit: 100 } })
          .then((r) => r.data),
      ]);
      setStats(statsRes);
      setChunks(chunkRes.chunks || []);
    } catch {
      setChunks([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleAction(chunkId: string, action: "vet" | "reject") {
    setActing(chunkId);
    setConfirmReject(null);
    try {
      await client.post(`/rag/review/${chunkId}/${action}`);
      setChunks((prev) => prev.filter((c) => c.chunk_id !== chunkId));
      if (stats) {
        const key = chunks.find((c) => c.chunk_id === chunkId)
          ?.scan_status as keyof ReviewStats;
        if (key && stats[key] > 0)
          setStats({ ...stats, [key]: stats[key] - 1 });
      }
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Review Queue
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Chunks flagged by index-time injection scanning or awaiting initial
          review. Each flag shows which pattern matched so you can quickly
          distinguish real threats from false positives (e.g. code discussing
          LLM prompts).
        </p>
      </div>

      {stats && (
        <div className="flex gap-4">
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
        </div>
      )}

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
          {chunks.map((chunk) => (
            <div
              key={chunk.chunk_id}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-slate-800/50"
            >
              <div className="flex items-start justify-between gap-4">
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
                    {chunk.origin_type && (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-slate-700/50 dark:text-slate-400">
                        {chunk.origin_type}
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
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-gray-100 bg-gray-50 p-2 text-sm text-gray-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400">
                    {chunk.text_preview}
                  </pre>

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
                    <ShieldCheck className="h-3.5 w-3.5" /> Vet
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
