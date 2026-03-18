import { useParams, useNavigate } from "react-router-dom";
import {
  useTrace,
  useAssistantChat,
  useDeleteTrace,
  useClearCriticData,
  useCriticModels,
  useRunCritic,
} from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
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
  executor: "#10b981",
  writer: "#f59e0b",
  critic: "#ef4444",
  final_scrubber: "#64748b",
  respond: "#06b6d4",
  patch_integrity_gate: "#8b5cf6",
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
  traceId,
  onSpanAssistant,
}: {
  span: SpanRecord;
  index: number;
  traceStart: number;
  traceId: string;
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
          {call.prompt_tokens}+{call.completion_tokens} tok
        </span>
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
                    (scrollable, {call.prompt_full?.length.toLocaleString()} chars)
                  </span>
                )}
              </p>
              <pre className="mt-1 max-h-80 overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300">
                {promptText}
              </pre>
            </div>
          )}
          {completionText && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Completion
                {(call.completion_full?.length ?? 0) > 500 && (
                  <span className="ml-2 text-gray-400">
                    (scrollable, {call.completion_full?.length.toLocaleString()} chars)
                  </span>
                )}
              </p>
              <pre className="mt-1 max-h-80 overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300">
                {completionText}
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
  const byModel: Record<string, { tokens: number; prompt: number; completion: number }> = {};
  for (const span of spans || []) {
    for (const call of span.llm_calls || []) {
      const model = call.model || "unknown";
      if (!byModel[model]) byModel[model] = { tokens: 0, prompt: 0, completion: 0 };
      byModel[model].tokens += call.total_tokens || 0;
      byModel[model].prompt += call.prompt_tokens || 0;
      byModel[model].completion += call.completion_tokens || 0;
    }
  }
  const entries = Object.entries(byModel);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
        Token cost by role
      </h3>
      <div className="space-y-1.5 text-sm">
        {entries.map(([model, v]) => (
          <div key={model} className="flex items-center justify-between gap-4">
            <span className="font-mono text-gray-700 dark:text-gray-300">{model}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {v.tokens.toLocaleString()} tok
              <span className="ml-2 text-xs">
                ({v.prompt.toLocaleString()} in / {v.completion.toLocaleString()} out)
              </span>
            </span>
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

    navigate("/assistant", { state: { context: contextPayload } });
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
                {m.name}
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
                {trace.manual_critic.model && (
                  <span className="ml-2 font-mono text-xs font-normal text-indigo-500">
                    {trace.manual_critic.model as string}
                  </span>
                )}
              </h3>
              <CriticScoresPanel scores={trace.manual_critic as Record<string, unknown>} />
              {trace.manual_critic.overall_assessment && (
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                  {trace.manual_critic.overall_assessment as string}
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
              traceId={traceId || ""}
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
