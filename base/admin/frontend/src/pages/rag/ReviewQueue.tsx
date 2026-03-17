import { useState, useEffect, useCallback } from "react";
import { ShieldAlert, ShieldCheck, Trash2, Loader2 } from "lucide-react";

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
}

interface ReviewStats {
  flagged: number;
  unscanned: number;
}

const STATUS_BADGE: Record<string, string> = {
  flagged: "bg-red-500/20 text-red-400 border border-red-500/30",
  unscanned: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  clean: "bg-green-500/20 text-green-400 border border-green-500/30",
};

export default function ReviewQueue() {
  const [chunks, setChunks] = useState<ReviewChunk[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [filter, setFilter] = useState<"flagged" | "unscanned" | "all">("flagged");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, chunkRes] = await Promise.all([
        fetch("/api/v1/rag/review/stats").then((r) => r.json()),
        fetch(`/api/v1/rag/review?status=${filter}&limit=100`).then((r) => r.json()),
      ]);
      setStats(statsRes);
      setChunks(chunkRes.chunks || []);
    } catch {
      setChunks([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleAction(chunkId: string, action: "vet" | "reject") {
    setActing(chunkId);
    try {
      await fetch(`/api/v1/rag/review/${chunkId}/${action}`, { method: "POST" });
      setChunks((prev) => prev.filter((c) => c.chunk_id !== chunkId));
      if (stats) {
        const key = chunks.find((c) => c.chunk_id === chunkId)?.scan_status as keyof ReviewStats;
        if (key && stats[key] > 0) setStats({ ...stats, [key]: stats[key] - 1 });
      }
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Review Queue</h1>
        <p className="mt-1 text-sm text-slate-400">
          Chunks flagged by index-time injection scanning. Review and vet or reject.
        </p>
      </div>

      {stats && (
        <div className="flex gap-4">
          <div className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2">
            <ShieldAlert className="h-4 w-4 text-red-400" />
            <span className="text-sm text-slate-300">{stats.flagged} flagged</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2">
            <ShieldCheck className="h-4 w-4 text-yellow-400" />
            <span className="text-sm text-slate-300">{stats.unscanned} unscanned</span>
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
                : "bg-slate-800 text-slate-400 hover:text-white"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : chunks.length === 0 ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-8 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-green-400" />
          <p className="mt-2 text-sm text-slate-400">No chunks need review.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {chunks.map((chunk) => (
            <div
              key={chunk.chunk_id}
              className="rounded-lg border border-slate-700 bg-slate-800/50 p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[chunk.scan_status] || STATUS_BADGE.unscanned}`}>
                      {chunk.scan_status}
                    </span>
                    <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                      {chunk.authority}
                    </span>
                    <span className="truncate text-sm font-medium text-slate-200">
                      {chunk.document_name || chunk.doc_id}
                    </span>
                  </div>
                  {chunk.heading_path && (
                    <p className="mt-1 text-xs text-slate-500">{chunk.heading_path}</p>
                  )}
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-400">
                    {chunk.text_preview}
                  </p>
                  {chunk.source_url && (
                    <a
                      href={chunk.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 text-xs text-blue-400 hover:underline"
                    >
                      {chunk.source_url}
                    </a>
                  )}
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  <button
                    disabled={acting === chunk.chunk_id}
                    onClick={() => handleAction(chunk.chunk_id, "vet")}
                    className="flex items-center gap-1 rounded-md bg-green-600/20 px-3 py-1.5 text-sm text-green-400 hover:bg-green-600/30 disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Vet
                  </button>
                  <button
                    disabled={acting === chunk.chunk_id}
                    onClick={() => handleAction(chunk.chunk_id, "reject")}
                    className="flex items-center gap-1 rounded-md bg-red-600/20 px-3 py-1.5 text-sm text-red-400 hover:bg-red-600/30 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
