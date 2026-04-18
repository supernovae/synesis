import { useParams, useNavigate } from "react-router-dom";
import {
  useTrace,
  useTraceChain,
  useAssistantChat,
  useDeleteTrace,
  useClearCriticData,
  useCriticModels,
  useRunCritic,
} from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import RichContent from "../../components/common/RichContent";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Zap,
  Send,
  Loader2,
  Bot,
  User,
  Maximize2,
  Minimize2,
  ExternalLink,
  X,
  Trash2,
  Eraser,
  Play,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import MarkdownContent from "../../components/common/MarkdownContent";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { SpanRecord, LLMCallRecord } from "../../types";

function fmtDate(ts: number) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

function fmtDuration(ms: number) {
  if (!ms) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number) {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const NODE_COLORS: Record<string, string> = {
  entry_pipeline: "#6366f1",
  router: "#8b5cf6",
  planner: "#3b82f6",
  plan_gate: "#2563eb",
  writer: "#f59e0b",
  critic: "#ef4444",
  final_scrubber: "#64748b",
  respond: "#06b6d4",
};

function spanIntent(span: SpanRecord): string {
  if (span.intent) return span.intent;
  const node = span.node_name.replace(/_/g, " ");
  const model = span.llm_calls?.[0]?.model;
  return model ? `${node} (${model})` : node;
}

function SpanRow({
  span,
  index,
  traceStart,
  onSpanAssistant,
}: {
  span: SpanRecord;
  index: number;
  traceStart: number;
  onSpanAssistant: (spanIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const offset = span.start_time ? (span.start_time - traceStart) * 1000 : 0;
  const color = NODE_COLORS[span.node_name] || "#6b7280";
  const label = spanIntent(span);

  return (
    <div className="border-b border-gray-100 dark:border-gray-700">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        {(span.llm_calls?.length > 0 || (span.metadata && Object.keys(span.metadata).length > 0)) ? (
          open ? (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400" />
          )
        ) : (
          <span className="h-4 w-4 flex-shrink-0" />
        )}
        <span
          className="inline-block h-3 w-3 flex-shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-[48px] font-mono text-xs text-gray-500 dark:text-gray-400">
          #{index + 1}
        </span>
        <span className="min-w-[200px] text-sm font-medium text-gray-900 dark:text-white">
          {label}
        </span>
        <span className="text-xs text-gray-400">
          +{fmtDuration(offset)}
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <Clock className="h-3 w-3" />
          {fmtDuration(span.latency_ms)}
        </span>
        <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <Zap className="h-3 w-3" />
          {span.tokens_used || 0} tok
        </span>
        {span.confidence > 0 && (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            {(span.confidence * 100).toFixed(0)}%
          </span>
        )}
        {span.outcome && span.outcome !== "success" && (
          <StatusBadge status={span.outcome === "error" ? "error" : "warning"} label={span.outcome} />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSpanAssistant(index);
          }}
          className="rounded bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
        >
          Summarize with AI
        </button>
      </button>

      {open && (
        <div className="ml-12 border-l-2 border-gray-200 pb-2 pl-4 dark:border-gray-600">
          {span.metadata && Object.keys(span.metadata).length > 0 && (
            <div className="mb-2 space-y-1">
              {Object.entries(span.metadata).map(([key, value]) => (
                <div key={key} className="rounded bg-gray-50 px-3 py-2 dark:bg-gray-800">
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">{key.replace(/_/g, ' ')}</span>
                  {typeof value === 'object' && value !== null ? (
                    <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
                      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
                        <div key={k} className="flex items-baseline gap-1 text-xs">
                          <span className="text-gray-500 dark:text-gray-400">{k.replace(/_/g, ' ')}:</span>
                          <span className="font-mono text-gray-800 dark:text-gray-200">
                            {typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : String(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="ml-2 font-mono text-xs text-gray-800 dark:text-gray-200">{String(value)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {span.llm_calls && span.llm_calls.length > 0 && span.llm_calls.map((call: LLMCallRecord, idx: number) => (
            <LLMCallRow key={idx} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function LLMCallRow({ call }: { call: LLMCallRecord }) {
  const [open, setOpen] = useState(false);
  const promptText = call.prompt_full || call.prompt_snippet || "";
  const completionText = call.completion_full || call.completion_snippet || "";
  const hasContent = !!promptText || !!completionText;

  return (
    <div className="mb-1 rounded-md border border-gray-100 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <Cpu className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
        <span className="font-mono text-xs text-gray-700 dark:text-gray-300">
          {call.model || "unknown"}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-gray-400">
          {(call.cached_prompt_tokens ?? 0) > 0 || (call.cache_creation_tokens ?? 0) > 0
            ? `${call.prompt_tokens} in` +
              ((call.cached_prompt_tokens ?? 0) > 0 ? ` (${call.cached_prompt_tokens} cached)` : "") +
              ((call.cache_creation_tokens ?? 0) > 0 ? ` (${call.cache_creation_tokens} cache-write)` : "") +
              ` + ${call.completion_tokens} out`
            : `${call.prompt_tokens}+${call.completion_tokens} tok`}
        </span>
        {typeof call.estimated_cost === "number" || typeof call.actual_cost === "number" ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {typeof call.estimated_cost === "number" && (
              <span title="Estimated (Forecast)">est. {fmtCost(call.estimated_cost)}</span>
            )}
            {typeof call.estimated_cost === "number" && typeof call.actual_cost === "number" && (
              <span className="mx-1 text-gray-300 dark:text-gray-600">·</span>
            )}
            {typeof call.actual_cost === "number" && (
              <span title="Actual (from API)">act. {fmtCost(call.actual_cost)}</span>
            )}
          </span>
        ) : null}
        <span className="text-xs text-gray-400">
          {fmtDuration(call.latency_ms)}
        </span>
        {hasContent &&
          (open ? (
            <ChevronDown className="h-3 w-3 text-gray-400" />
          ) : (
            <ChevronRight className="h-3 w-3 text-gray-400" />
          ))}
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {promptText && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Prompt
                {(call.prompt_full?.length ?? 0) > 500 && (
                  <span className="ml-2 text-gray-400">
                    ({call.prompt_full?.length.toLocaleString()} chars)
                  </span>
                )}
              </p>
              <RichContent content={promptText} maxHeight="max-h-80" />
            </div>
          )}
          {completionText && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Completion
                {(call.completion_full?.length ?? 0) > 500 && (
                  <span className="ml-2 text-gray-400">
                    ({call.completion_full?.length.toLocaleString()} chars)
                  </span>
                )}
              </p>
              <RichContent content={completionText} maxHeight="max-h-80" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WaterfallChart({ spans, traceStart }: { spans: SpanRecord[]; traceStart: number }) {
  if (!spans || spans.length === 0) return null;

  const data = spans.map((s) => ({
    name: s.node_name,
    offset: s.start_time ? (s.start_time - traceStart) * 1000 : 0,
    duration: s.latency_ms,
    fill: NODE_COLORS[s.node_name] || "#6b7280",
  }));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
        Waterfall Timeline
      </h3>
      <ResponsiveContainer width="100%" height={Math.max(120, data.length * 36)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ left: 110, right: 20, top: 4, bottom: 4 }}
        >
          <XAxis
            type="number"
            tickFormatter={(v) => fmtDuration(v)}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 11 }}
            width={100}
          />
          <Tooltip
            formatter={(v) => fmtDuration(Number(v ?? 0))}
            labelFormatter={(l) => `Node: ${l}`}
          />
          <Bar dataKey="duration" radius={[0, 4, 4, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CriticScoresPanel({ scores }: { scores: Record<string, unknown> }) {
  if (!scores || Object.keys(scores).length === 0) return null;

  const fields = [
    { key: "weighted_overall", label: "Overall" },
    { key: "task_faithfulness", label: "Faithfulness" },
    { key: "constraint_compliance", label: "Compliance" },
    { key: "coverage", label: "Coverage" },
    { key: "judgment_quality", label: "Judgment" },
  ];

  const barData = fields
    .filter((f) => scores[f.key] !== undefined && scores[f.key] !== null)
    .map((f) => ({
      name: f.label,
      score: Number(scores[f.key]) || 0,
    }));

  if (barData.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Critic Scores
        </h3>
        {scores.approved !== undefined && (
          <StatusBadge
            status={scores.approved ? "approved" : "rejected"}
          />
        )}
      </div>
      <ResponsiveContainer width="100%" height={barData.length * 36 + 20}>
        <BarChart
          data={barData}
          layout="vertical"
          margin={{ left: 80, right: 20, top: 4, bottom: 4 }}
        >
          <XAxis type="number" domain={[0, 10]} tick={{ fontSize: 11 }} />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 11 }}
            width={75}
          />
          <Tooltip formatter={(v) => (v == null ? "" : Number(v).toFixed(1))} />
          <Bar dataKey="score" fill="#6366f1" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
      {Array.isArray(scores.failure_modes) &&
        scores.failure_modes.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-gray-500">Failure modes:</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {(scores.failure_modes as string[]).map((fm: string, i: number) => (
                <span
                  key={i}
                  className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300"
                >
                  {fm}
                </span>
              ))}
            </div>
          </div>
        )}
    </div>
  );
}

function TokenCostByRole({ spans }: { spans: SpanRecord[] }) {
  const byModel: Record<string, { tokens: number; prompt: number; completion: number; cached: number; cost: number }> = {};
  for (const span of spans || []) {
    for (const call of span.llm_calls || []) {
      const model = call.model || "unknown";
      if (!byModel[model]) byModel[model] = { tokens: 0, prompt: 0, completion: 0, cached: 0, cost: 0 };
      byModel[model].tokens += call.total_tokens || 0;
      byModel[model].prompt += call.prompt_tokens || 0;
      byModel[model].completion += call.completion_tokens || 0;
      byModel[model].cached += call.cached_prompt_tokens ?? 0;
      byModel[model].cost += (call.actual_cost ?? call.estimated_cost ?? 0);
    }
  }
  const entries = Object.entries(byModel);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
        Token usage and cost by model
      </h3>
      <div className="space-y-1.5 text-sm">
        {entries.map(([model, v]) => (
          <div key={model} className="flex items-center justify-between gap-4">
            <span className="font-mono text-gray-700 dark:text-gray-300">{model}</span>
            <div className="text-right text-gray-500 dark:text-gray-400">
              <div>{v.tokens.toLocaleString()} tok</div>
              <div className="text-xs">
                ({v.prompt.toLocaleString()} in
                {v.cached > 0 ? `, ${v.cached.toLocaleString()} cached` : ""} / {v.completion.toLocaleString()} out)
              </div>
              <div className="text-xs">{fmtCost(v.cost)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RolePhaseSummary({ spans }: { spans: SpanRecord[] }) {
  const byNode: Record<string, number> = {};
  for (const s of spans || []) {
    const n = s.node_name || "unknown";
    byNode[n] = (byNode[n] || 0) + s.latency_ms;
  }
  const entries = Object.entries(byNode).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
        Role phase summary
      </h3>
      <div className="space-y-1.5 text-sm">
        {entries.map(([node, ms]) => (
          <div key={node} className="flex items-center justify-between gap-4">
            <span className="font-mono text-gray-700 dark:text-gray-300">{node}</span>
            <span className="text-gray-500 dark:text-gray-400">{fmtDuration(ms)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

interface OptLedger {
  inputCharsOriginal?: number;
  inputCharsAfterReduction?: number;
  inputCharsAfterPruning?: number;
  inputCharsAfterDedup?: number;
  inputCharsAfterNormalization?: number;
  inputCharsFinal?: number;
  toolResultsOriginalChars?: number;
  toolResultsReducedChars?: number;
  responseDedupHits?: number;
  responseDedupMisses?: number;
  blockStoreHits?: number;
  contentDedupHits?: number;
  jitterLinesExtracted?: number;
  historicalNormReplacements?: number;
  toolIdRewrites?: number;
  prefixStableBytes?: number;
  upstreamCachedTokens?: number;
  estimatedTokensSaved?: number;
  pipelineLatencyMs?: number;
}

function OptimizationLedgerPanel({ ledger }: { ledger: OptLedger }) {
  const saved = ledger.estimatedTokensSaved ?? 0;
  const origChars = ledger.inputCharsOriginal ?? 0;
  const finalChars = ledger.inputCharsFinal ?? 0;
  const reductionPct = origChars > 0 ? ((origChars - finalChars) / origChars * 100) : 0;

  const stages = [
    { label: "Original input", chars: origChars },
    { label: "After tool reduction", chars: ledger.inputCharsAfterReduction },
    { label: "After transcript pruning", chars: ledger.inputCharsAfterPruning },
    { label: "After content dedup", chars: ledger.inputCharsAfterDedup },
    { label: "After normalization", chars: ledger.inputCharsAfterNormalization },
    { label: "Final (sent to provider)", chars: finalChars },
  ].filter(s => s.chars != null && s.chars > 0) as { label: string; chars: number }[];

  const maxChars = Math.max(...stages.map(s => s.chars), 1);

  const hits = [
    { label: "Response dedup hits", value: ledger.responseDedupHits },
    { label: "Response dedup misses", value: ledger.responseDedupMisses },
    { label: "Block store hits", value: ledger.blockStoreHits },
    { label: "Content dedup hits", value: ledger.contentDedupHits },
    { label: "Jitter lines extracted", value: ledger.jitterLinesExtracted },
    { label: "Historical normalizations", value: ledger.historicalNormReplacements },
    { label: "Tool ID rewrites", value: ledger.toolIdRewrites },
  ].filter(h => h.value != null && h.value > 0) as { label: string; value: number }[];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Optimization Pipeline
        </h3>
        <div className="flex items-center gap-3">
          {saved > 0 && (
            <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">
              ~{fmtTokens(saved)} tokens saved
            </span>
          )}
          {reductionPct > 0 && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {reductionPct.toFixed(1)}% reduction
            </span>
          )}
          {(ledger.pipelineLatencyMs ?? 0) > 0 && (
            <span className="text-xs text-gray-400">
              {fmtDuration(ledger.pipelineLatencyMs!)} pipeline
            </span>
          )}
        </div>
      </div>

      {/* Funnel visualization */}
      {stages.length > 1 && (
        <div className="mb-4 space-y-1">
          {stages.map((stage, i) => {
            const widthPct = Math.max(8, (stage.chars / maxChars) * 100);
            const isLast = i === stages.length - 1;
            return (
              <div key={stage.label} className="flex items-center gap-3">
                <span className="w-44 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
                  {stage.label}
                </span>
                <div className="relative flex-1">
                  <div
                    className={`h-5 rounded ${isLast ? "bg-green-400 dark:bg-green-600" : "bg-indigo-200 dark:bg-indigo-800"}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span className="w-20 text-right font-mono text-xs text-gray-700 dark:text-gray-300">
                  {stage.chars.toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Metrics grid */}
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {(ledger.toolResultsOriginalChars ?? 0) > 0 && (
          <div className="flex justify-between gap-2 border-b border-gray-100 pb-1 dark:border-gray-800">
            <span className="text-xs text-gray-500 dark:text-gray-400">Tool results reduced</span>
            <span className="font-mono text-xs text-gray-900 dark:text-white">
              {(ledger.toolResultsOriginalChars ?? 0).toLocaleString()} → {(ledger.toolResultsReducedChars ?? 0).toLocaleString()} chars
            </span>
          </div>
        )}
        {(ledger.upstreamCachedTokens ?? 0) > 0 && (
          <div className="flex justify-between gap-2 border-b border-gray-100 pb-1 dark:border-gray-800">
            <span className="text-xs text-gray-500 dark:text-gray-400">Upstream KV-cached</span>
            <span className="font-mono text-xs text-green-600 dark:text-green-400">
              {fmtTokens(ledger.upstreamCachedTokens!)} tokens
            </span>
          </div>
        )}
        {(ledger.prefixStableBytes ?? 0) > 0 && (
          <div className="flex justify-between gap-2 border-b border-gray-100 pb-1 dark:border-gray-800">
            <span className="text-xs text-gray-500 dark:text-gray-400">Prefix stable bytes</span>
            <span className="font-mono text-xs text-gray-900 dark:text-white">
              {(ledger.prefixStableBytes!).toLocaleString()}
            </span>
          </div>
        )}
        {hits.map(h => (
          <div key={h.label} className="flex justify-between gap-2 border-b border-gray-100 pb-1 dark:border-gray-800">
            <span className="text-xs text-gray-500 dark:text-gray-400">{h.label}</span>
            <span className="font-mono text-xs text-gray-900 dark:text-white">{h.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const QUICK_PROMPTS = [
  "Summarize this trace.",
  "Where did it fail or underperform?",
  "Where did the critic reject or flag issues?",
  "Where was evidence insufficient or missing?",
];

function TraceAssistantPanel({
  traceId,
  spanIndex,
  onClose,
  traceJson,
}: {
  traceId: string;
  spanIndex: number | null;
  onClose: () => void;
  traceJson?: string;
}) {
  const [message, setMessage] = useState("");
  const [replies, setReplies] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [expanded, setExpanded] = useState(false);
  const chatMutation = useAssistantChat();
  const endRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [replies]);

  const send = useCallback(
    (msg: string) => {
      if (!msg.trim()) return;
      setReplies((r) => [...r, { role: "user", content: msg }]);
      setMessage("");
      chatMutation.mutate(
        {
          message: msg,
          trace_id: traceId,
          ...(spanIndex !== null ? { span_index: spanIndex } : {}),
        },
        {
          onSuccess: (data) => {
            setReplies((r) => [...r, { role: "assistant", content: data.response }]);
          },
          onError: () => {
            setReplies((r) => [...r, { role: "assistant", content: "Failed to get response." }]);
          },
        },
      );
    },
    [chatMutation, traceId, spanIndex],
  );

  const sendToAdminAssistant = () => {
    const conversationText = replies
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const contextPayload = [
      `Trace ID: ${traceId}`,
      spanIndex !== null ? `Span: #${spanIndex + 1}` : "",
      "--- Conversation ---",
      conversationText,
      traceJson ? "\n--- Trace Data ---\n" + traceJson.slice(0, 8000) : "",
    ]
      .filter(Boolean)
      .join("\n");

    navigate("/assistant/admin", { state: { context: contextPayload } });
  };

  // Fullscreen overlay vs inline panel
  const panelClasses = expanded
    ? "fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900 p-6"
    : "rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900";

  const chatAreaClasses = expanded
    ? "flex-1 min-h-0 space-y-3 overflow-y-auto rounded border border-gray-100 p-3 dark:border-gray-700"
    : "max-h-96 space-y-3 overflow-y-auto rounded border border-gray-100 p-2 dark:border-gray-700";

  return (
    <div className={panelClasses}>
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-5 w-5 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Trace Assistant
          {spanIndex !== null && (
            <span className="ml-2 font-normal text-gray-500">(span #{spanIndex + 1})</span>
          )}
        </h3>
        <span className="flex-1" />
        {replies.length > 0 && (
          <button
            type="button"
            onClick={sendToAdminAssistant}
            title="Continue in Admin Assistant with full context"
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in Assistant
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? "Shrink" : "Expand"}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Quick prompts */}
      <div className="mb-2 flex flex-wrap gap-1">
        {QUICK_PROMPTS.map((q, i) => (
          <button
            key={i}
            type="button"
            onClick={() => send(q)}
            disabled={chatMutation.isPending}
            className="rounded bg-indigo-100 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/60 disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Chat messages */}
      <div className={chatAreaClasses}>
        {replies.length === 0 && (
          <p className="py-4 text-center text-xs text-gray-400">
            Ask a question or pick a quick prompt above.
          </p>
        )}
        {replies.map((m, i) => (
          <div
            key={i}
            className={`flex gap-2 ${m.role === "user" ? "justify-end" : ""}`}
          >
            {m.role === "assistant" && (
              <Bot className="mt-1 h-4 w-4 flex-shrink-0 text-indigo-400" />
            )}
            <div
              className={`rounded-lg px-3 py-2 ${
                expanded ? "max-w-[90%]" : "max-w-[85%]"
              } ${
                m.role === "user"
                  ? "bg-indigo-100 text-sm text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200"
                  : "bg-gray-50 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
              }`}
            >
              {m.role === "assistant" ? (
                <MarkdownContent content={m.content} />
              ) : (
                <span className="text-sm">{m.content}</span>
              )}
            </div>
            {m.role === "user" && (
              <User className="mt-1 h-4 w-4 flex-shrink-0 text-gray-400" />
            )}
          </div>
        ))}
        {chatMutation.isPending && (
          <div className="flex gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
            <span className="text-sm text-gray-500">Thinking…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send(message)}
          placeholder="Ask about this trace…"
          className="flex-1 rounded border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <button
          type="button"
          onClick={() => send(message)}
          disabled={chatMutation.isPending || !message.trim()}
          className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          Send
        </button>
      </div>
    </div>
  );
}

export default function TraceDetail() {
  const { traceId } = useParams<{ traceId: string }>();
  const navigate = useNavigate();
  const { data: trace, isLoading, refetch: refetchTrace } = useTrace(traceId || "");
  const { data: traceChainData } = useTraceChain(traceId || "");
  const [assistantSpanIndex, setAssistantSpanIndex] = useState<number | null>(null);
  const [showTraceAssistant, setShowTraceAssistant] = useState(false);
  const deleteTrace = useDeleteTrace();
  const clearCritic = useClearCriticData();
  const { data: modelData } = useCriticModels();
  const runCritic = useRunCritic();
  const [selectedModel, setSelectedModel] = useState("");

  const hasCriticData = !!(
    trace?.critic_scores && Object.keys(trace.critic_scores).length > 0
  ) || !!(
    trace?.background_critic && Object.keys(trace.background_critic).length > 0
  ) || !!(
    trace?.manual_critic && Object.keys(trace.manual_critic).length > 0
  );

  if (isLoading) {
    return <div className="h-96 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />;
  }

  if (!trace) {
    return <EmptyState title="Trace not found" />;
  }

  const traceStart = trace.spans?.length
    ? Math.min(...trace.spans.map((s) => s.start_time || trace.timestamp))
    : trace.timestamp;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/traces")}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Trace Detail
          </h1>
          <p className="mt-0.5 font-mono text-xs text-gray-400">
            {trace.trace_id}
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-2">
          {/* Run Critic */}
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            <option value="">Critic model…</option>
            {(modelData?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (!selectedModel || !traceId) return;
              runCritic.mutate(
                { trace_id: traceId, model: selectedModel },
                { onSuccess: () => refetchTrace() },
              );
            }}
            disabled={!selectedModel || runCritic.isPending}
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
            title="Run critic on this trace"
          >
            <Play className="h-3 w-3" />
            {runCritic.isPending ? "Running…" : "Run Critic"}
          </button>

          {/* Clear Critic */}
          {hasCriticData && (
            <button
              onClick={() => {
                if (confirm("Clear all critic data from this trace? The trace itself will be preserved.")) {
                  clearCritic.mutate(traceId!, {
                    onSuccess: () => refetchTrace(),
                  });
                }
              }}
              disabled={clearCritic.isPending}
              className="inline-flex items-center gap-1 rounded bg-amber-50 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:bg-amber-900/20 dark:text-amber-300 dark:hover:bg-amber-900/40"
              title="Clear critic data (keeps trace)"
            >
              <Eraser className="h-3 w-3" />
              Clear Critic
            </button>
          )}

          {/* Delete Trace */}
          <button
            onClick={() => {
              if (confirm("Delete this trace and all its data permanently?")) {
                deleteTrace.mutate(traceId!, {
                  onSuccess: () => navigate("/traces"),
                });
              }
            }}
            disabled={deleteTrace.isPending}
            className="inline-flex items-center gap-1 rounded bg-red-50 px-2.5 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-50 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40"
            title="Delete trace permanently"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>

          <StatusBadge status={trace.has_error ? "error" : "ok"} />
        </div>
      </div>

      {/* Header metrics */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Time</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {fmtDate(trace.timestamp)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">User</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {trace.user_id || "—"}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Duration</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {fmtDuration(trace.total_duration_ms)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Tokens</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {trace.total_tokens.toLocaleString()}
          </p>
          {(trace.total_cached_prompt_tokens ?? 0) > 0 && (
            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              {trace.total_cached_prompt_tokens!.toLocaleString()} cached
            </p>
          )}
          {(trace.total_cache_creation_tokens ?? 0) > 0 && (
            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              {trace.total_cache_creation_tokens!.toLocaleString()} cache-write
            </p>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Cost (trace row)</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white" title="What we forecast if API doesn't provide costs">
            est. {fmtCost(trace.estimated_cost_usd)}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400" title="Actual costs from API">
            actual: {fmtCost(trace.actual_cost_usd ?? 0)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Difficulty</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {trace.difficulty.toFixed(2)}
          </p>
        </div>
      </div>

      {traceChainData && (traceChainData.chain?.length ?? 0) > 1 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Conversation trace chain ({traceChainData.chain.length} turns)
          </h3>
          <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">
            Root trace: <span className="font-mono">{traceChainData.root_trace_id ?? "unknown"}</span>
          </div>
          <div className="space-y-2">
            {traceChainData.chain.map((item, idx) => {
              const isCurrent = item.trace_id === trace.trace_id;
              return (
                <button
                  key={item.trace_id}
                  onClick={() => navigate(`/traces/${item.trace_id}`)}
                  className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left transition-colors ${
                    isCurrent
                      ? "border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/30"
                      : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Turn {idx + 1} - {fmtDate(item.timestamp)}</div>
                    <div className="truncate text-sm text-gray-900 dark:text-gray-100">
                      {item.query_snippet || "No query snippet"}
                    </div>
                  </div>
                  <StatusBadge status={item.has_error ? "error" : "ok"} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Query */}
      {trace.query_snippet && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500">Query</p>
          <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">
            {trace.query_snippet}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {trace.task_type && (
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {trace.task_type}
              </span>
            )}
            {trace.is_code_task && (
              <span className="rounded bg-purple-50 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                code
              </span>
            )}
            {(trace.domain_tags || []).map((tag) => (
              <span
                key={tag}
                className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              >
                {tag}
              </span>
            ))}
            {trace.short_circuit_reason && (
              <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {trace.short_circuit_reason.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Trace context (budget/failure state) */}
      {trace.trace_context && Object.keys(trace.trace_context).length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Trace context</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["turn_index", "Turn index"],
              ["phase", "Phase"],
              ["reducedToolResults", "Reduced tool results"],
              ["tokensSavedByReduction", "Tokens saved (reduction)"],
              ["token_budget_total", "Budget total"],
              ["token_budget_remaining", "Budget remaining"],
              ["token_budget_consumed", "Budget consumed"],
              ["token_budget_state", "Budget state"],
              ["failure_stage", "Failure stage"],
              ["failure_type", "Failure type"],
            ].map(([key, label]) => {
              const value = trace.trace_context?.[key];
              if (value === undefined || value === null || value === "") return null;
              return (
                <div key={key} className="flex justify-between gap-2 border-b border-gray-100 pb-1 dark:border-gray-800">
                  <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
                  <dd className="font-mono font-medium text-gray-900 dark:text-white">
                    {typeof value === "number" ? value.toLocaleString() : String(value)}
                  </dd>
                </div>
              );
            })}
          </dl>
          {trace.trace_context.failure_reason ? (
            <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">
              <span className="font-semibold">Failure reason:</span> {String(trace.trace_context.failure_reason)}
            </p>
          ) : null}
        </div>
      )}

      {/* Sensemaking (planner-ts enrichment) */}
      {trace.sensemaking && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Sensemaking
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Domain profile */}
            {trace.sensemaking.domain_profile?.domains && trace.sensemaking.domain_profile.domains.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">Domain Profile</p>
                <div className="space-y-1">
                  {trace.sensemaking.domain_profile.domains.slice(0, 5).map((d) => (
                    <div key={d.key} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-600 dark:text-gray-400">{d.key.replace(/_/g, " ")}</span>
                      <div className="flex items-center gap-1">
                        <div
                          className="h-2 rounded-full bg-blue-400"
                          style={{ width: `${Math.round(d.weight * 80)}px` }}
                        />
                        <span className="min-w-[40px] text-right font-mono text-xs text-gray-900 dark:text-white">
                          {(d.weight * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Frame coherence + confidence */}
            <div className="space-y-2">
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">Frame Coherence</p>
                <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                  trace.sensemaking.frame_coherence === "focused"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    : trace.sensemaking.frame_coherence === "composite"
                      ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
                      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                }`}>
                  {trace.sensemaking.frame_coherence}
                </span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">Chat confidence</p>
                <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                  {(trace.sensemaking.planner_confidence * 100).toFixed(0)}%
                </span>
              </div>
              {trace.sensemaking.clarification_triggered && (
                <div>
                  <p className="mb-1 text-xs font-medium text-gray-500">Clarification</p>
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    triggered
                  </span>
                  {trace.sensemaking.clarification_question && (
                    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                      {trace.sensemaking.clarification_question}
                    </p>
                  )}
                </div>
              )}
            </div>
            {/* Assumptions */}
            {trace.sensemaking.assumptions && trace.sensemaking.assumptions.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">
                  Assumptions ({trace.sensemaking.assumptions.length})
                </p>
                <ul className="space-y-1">
                  {trace.sensemaking.assumptions.slice(0, 6).map((a, i) => (
                    <li key={i} className="text-xs text-gray-600 dark:text-gray-400">
                      {a}
                    </li>
                  ))}
                </ul>
                {trace.sensemaking.assumption_tags_applied && (
                  <div className="mt-2 flex gap-2 text-[11px] text-gray-500">
                    <span>tags: {trace.sensemaking.assumption_tags_applied.assumption}</span>
                    <span>estimates: {trace.sensemaking.assumption_tags_applied.estimate}</span>
                    <span>clarified: {trace.sensemaking.assumption_tags_applied.clarified}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Classification (planner-ts enrichment) */}
      {trace.classification && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Classification
          </h3>
          <div className="flex flex-wrap gap-2">
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              size: {trace.classification.task_size}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              effort: {trace.classification.effort_mode}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              tier: {trace.classification.model_tier}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              rag: {trace.classification.rag_mode}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              risk: {trace.classification.risk_score}
            </span>
            {trace.classification.cynefin_domain && (
              <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                cynefin: {trace.classification.cynefin_domain}
              </span>
            )}
            {trace.classification.plan_required && (
              <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                plan required
              </span>
            )}
          </div>
        </div>
      )}

      {/* Streaming metadata */}
      {trace.streaming && (
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
          <span className="text-xs text-gray-500">Streaming:</span>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {trace.streaming.mode}
          </span>
          {trace.streaming.time_to_first_token_ms != null && (
            <span className="text-xs text-gray-500">
              TTFT: <span className="font-mono font-medium text-gray-900 dark:text-white">{trace.streaming.time_to_first_token_ms}ms</span>
            </span>
          )}
        </div>
      )}

      {/* Optimization Pipeline (Yarn per-request ledger) */}
      {trace.optimization_ledger && (
        <OptimizationLedgerPanel ledger={trace.optimization_ledger} />
      )}

      {/* Token by role + Role phase summary */}
      <div className="grid gap-4 sm:grid-cols-2">
        <TokenCostByRole spans={trace.spans || []} />
        <RolePhaseSummary spans={trace.spans || []} />
      </div>

      {/* Waterfall + Critic side by side */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <WaterfallChart spans={trace.spans || []} traceStart={traceStart} />
        </div>
        <div className="space-y-4">
          <CriticScoresPanel scores={trace.critic_scores || {}} />
          {trace.manual_critic && Object.keys(trace.manual_critic).length > 0 && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
              <h3 className="mb-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                Manual Critic
                {typeof trace.manual_critic.model === "string" && (
                  <span className="ml-2 font-mono text-xs font-normal text-indigo-500">
                    {trace.manual_critic.model}
                  </span>
                )}
              </h3>
              <CriticScoresPanel scores={trace.manual_critic as Record<string, unknown>} />
              {typeof trace.manual_critic.overall_assessment === "string" && (
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                  {trace.manual_critic.overall_assessment}
                </p>
              )}
            </div>
          )}
          {trace.background_critic && Object.keys(trace.background_critic).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <h3 className="mb-2 text-sm font-semibold text-gray-600 dark:text-gray-400">
                Background Critic
              </h3>
              <CriticScoresPanel scores={trace.background_critic as Record<string, unknown>} />
            </div>
          )}
        </div>
      </div>

      {/* Trace assistant */}
      {traceId && (
        <div>
          {showTraceAssistant ? (
            <TraceAssistantPanel
              traceId={traceId}
              spanIndex={assistantSpanIndex}
              traceJson={JSON.stringify(trace, null, 2)}
              onClose={() => {
                setShowTraceAssistant(false);
                setAssistantSpanIndex(null);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowTraceAssistant(true)}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Open trace assistant — summarize or review this trace with AI
            </button>
          )}
        </div>
      )}

      {/* Phase Timings */}
      {trace.phase_timings && Object.keys(trace.phase_timings).length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Phase Timings
          </h3>
          <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(trace.phase_timings as Record<string, number>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([phase, ms]) => (
                <div key={phase} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-gray-500">{phase}</span>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2 rounded-full bg-indigo-400"
                      style={{
                        width: `${Math.min(120, Math.max(4, (ms / Math.max(...Object.values(trace.phase_timings as Record<string, number>))) * 120))}px`,
                      }}
                    />
                    <span className="min-w-[60px] text-right font-mono text-xs font-medium text-gray-900 dark:text-white">
                      {fmtDuration(ms)}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Writer context budgeting (rank-first evidence pack) */}
      {trace.context_curation && Object.keys(trace.context_curation).length > 0 && (
        <div
          className={`rounded-lg border p-4 dark:border-gray-700 ${
            trace.context_curation.budget_alert
              ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
              : trace.context_curation.low_utilization
                ? "border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-900/40"
                : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
          }`}
        >
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Writer context budgeting
          </h3>
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
            High-confidence evidence is packed first into token and character budgets. Alerts flag
            starvation of strong evidence; low utilization may mean retrieval over-fetch or easy
            questions with sparse context needs.
          </p>
          {Boolean(trace.context_curation.budget_alert) && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-100/80 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-100">
              <span className="font-semibold">Budget alert: </span>
              {String(trace.context_curation.budget_alert)}
            </div>
          )}
          {trace.context_curation.low_utilization === true && !trace.context_curation.budget_alert && (
            <div className="mb-3 rounded-md border border-slate-200 bg-slate-100/80 px-3 py-2 text-xs text-slate-800 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-200">
              Low utilization of evidence token budget — possible over-fetch or short answer path.
            </div>
          )}
          <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["packets_in", "Packets in"],
              ["packets_kept", "Packets kept"],
              ["excluded_count", "Excluded"],
              ["packets_truncated", "Truncated"],
              ["token_budget", "Token budget"],
              ["tokens_used", "Tokens used"],
              ["utilization", "Utilization"],
              ["char_budget", "Char budget"],
              ["chars_used", "Chars used"],
            ].map(([key, label]) => {
              const v = trace.context_curation![key];
              if (v === undefined || v === null) return null;
              const display =
                key === "utilization" && typeof v === "number"
                  ? `${(v * 100).toFixed(1)}%`
                  : typeof v === "number"
                    ? v.toLocaleString()
                    : String(v);
              return (
                <div key={key} className="flex justify-between gap-2 border-b border-gray-100 pb-1 dark:border-gray-800">
                  <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
                  <dd className="font-mono font-medium text-gray-900 dark:text-white">{display}</dd>
                </div>
              );
            })}
          </dl>
          {Array.isArray(trace.context_curation.excluded) && trace.context_curation.excluded.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Excluded / dropped (sample)
              </h4>
              <ul className="space-y-2 text-xs">
                {(trace.context_curation.excluded as Record<string, unknown>[]).slice(0, 12).map((row, i) => (
                  <li
                    key={i}
                    className="rounded border border-gray-100 bg-gray-50/80 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800/50"
                  >
                    <span className="font-medium text-gray-700 dark:text-gray-200">
                      {(row.reason as string) || "unknown"}
                    </span>
                    {row.score != null && (
                      <span className="ml-2 font-mono text-gray-500">score {(row.score as number).toFixed(3)}</span>
                    )}
                    {row.doc_hint ? (
                      <span className="ml-2 text-gray-600 dark:text-gray-300">{String(row.doc_hint)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Evidence + Taxonomy summary */}
      {(Object.keys(trace.evidence_summary || {}).length > 0 ||
        Object.keys(trace.taxonomy || {}).length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.keys(trace.evidence_summary || {}).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                Evidence Summary
              </h3>
              <dl className="space-y-1 text-sm">
                {Object.entries(trace.evidence_summary).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="text-gray-500">{k.replace(/_/g, " ")}</dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {typeof v === "number" ? v.toLocaleString() : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {Object.keys(trace.taxonomy || {}).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                Taxonomy
              </h3>
              <dl className="space-y-1 text-sm">
                {Object.entries(trace.taxonomy).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="text-gray-500">{k.replace(/_/g, " ")}</dt>
                    <dd className="max-w-[200px] truncate font-medium text-gray-900 dark:text-white">
                      {typeof v === "number" ? v.toLocaleString() : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}

      {/* Span tree */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Spans ({trace.spans?.length || 0})
          </h3>
        </div>
        {trace.spans && trace.spans.length > 0 ? (
          trace.spans.map((span, i) => (
            <SpanRow
              key={i}
              span={span}
              index={i}
              traceStart={traceStart}
              onSpanAssistant={(spanIndex) => {
                setAssistantSpanIndex(spanIndex);
                setShowTraceAssistant(true);
              }}
            />
          ))
        ) : (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            No spans recorded
          </div>
        )}
      </div>
    </div>
  );
}
