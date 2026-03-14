import { useParams, useNavigate } from "react-router-dom";
import { useTrace } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Zap,
} from "lucide-react";
import { useState } from "react";
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
  executor: "#10b981",
  writer: "#f59e0b",
  critic: "#ef4444",
  final_scrubber: "#64748b",
  respond: "#06b6d4",
  patch_integrity_gate: "#8b5cf6",
};

function SpanRow({ span, traceStart }: { span: SpanRecord; traceStart: number }) {
  const [open, setOpen] = useState(false);
  const offset = span.start_time ? (span.start_time - traceStart) * 1000 : 0;
  const color = NODE_COLORS[span.node_name] || "#6b7280";

  return (
    <div className="border-b border-gray-100 dark:border-gray-700">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        {span.llm_calls?.length > 0 ? (
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
        <span className="min-w-[140px] font-mono text-sm font-medium text-gray-900 dark:text-white">
          {span.node_name}
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
      </button>

      {open && span.llm_calls && span.llm_calls.length > 0 && (
        <div className="ml-12 border-l-2 border-gray-200 pb-2 pl-4 dark:border-gray-600">
          {span.llm_calls.map((call: LLMCallRecord, idx: number) => (
            <LLMCallRow key={idx} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function LLMCallRow({ call }: { call: LLMCallRecord }) {
  const [open, setOpen] = useState(false);

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
          {call.prompt_tokens}+{call.completion_tokens} tok
        </span>
        <span className="text-xs text-gray-400">
          {fmtDuration(call.latency_ms)}
        </span>
        {(call.prompt_snippet || call.completion_snippet) && (
          open ? (
            <ChevronDown className="h-3 w-3 text-gray-400" />
          ) : (
            <ChevronRight className="h-3 w-3 text-gray-400" />
          )
        )}
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {call.prompt_snippet && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Prompt
              </p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {call.prompt_snippet}
              </pre>
            </div>
          )}
          {call.completion_snippet && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Completion
              </p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {call.completion_snippet}
              </pre>
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
            formatter={(v: number) => fmtDuration(v)}
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
          <Tooltip formatter={(v: number) => v.toFixed(1)} />
          <Bar dataKey="score" fill="#6366f1" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
      {scores.failure_modes &&
        (scores.failure_modes as string[]).length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-gray-500">Failure modes:</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {(scores.failure_modes as string[]).map((fm, i) => (
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

export default function TraceDetail() {
  const { traceId } = useParams<{ traceId: string }>();
  const navigate = useNavigate();
  const { data: trace, isLoading } = useTrace(traceId || "");

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
        <StatusBadge status={trace.has_error ? "error" : "ok"} />
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
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Cost</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {fmtCost(trace.estimated_cost_usd)}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs text-gray-500">Difficulty</p>
          <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">
            {trace.difficulty.toFixed(2)}
          </p>
        </div>
      </div>

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
          </div>
        </div>
      )}

      {/* Waterfall + Critic side by side */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <WaterfallChart spans={trace.spans || []} traceStart={traceStart} />
        </div>
        <div>
          <CriticScoresPanel scores={trace.critic_scores || {}} />
        </div>
      </div>

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
            <SpanRow key={i} span={span} traceStart={traceStart} />
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
