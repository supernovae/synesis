import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTraces, useTraceStats } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { Activity, Clock, DollarSign, AlertTriangle } from "lucide-react";

function fmtDate(ts: number) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number) {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export default function TraceList() {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [errorFilter, setErrorFilter] = useState<boolean | undefined>(
    undefined,
  );
  const [taskType, setTaskType] = useState("");
  const limit = 30;

  const { data, isLoading } = useTraces({
    offset,
    limit,
    has_error: errorFilter,
    task_type: taskType || undefined,
  });
  const { data: stats } = useTraceStats();
  const traces = data?.traces ?? [];
  const total = data?.total ?? 0;

  const enriched = traces.map((t) => ({
    ...t,
    _time: fmtDate(t.timestamp),
    _duration: fmtDuration(t.total_duration_ms),
    _cost: fmtCost(t.estimated_cost_usd),
    _query: t.query_snippet?.slice(0, 80) || "—",
    _status: t.has_error ? "error" : "ok",
    _critic: t.critic_scores?.weighted_overall
      ? `${Number(t.critic_scores.weighted_overall).toFixed(1)}`
      : "—",
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          LLM Traces
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Per-request pipeline traces with LLM call detail
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard
            label="Traces (24h)"
            value={stats.total_traces_24h}
            icon={Activity}
          />
          <MetricCard
            label="Avg Latency"
            value={fmtDuration(stats.avg_duration_ms)}
            icon={Clock}
          />
          <MetricCard
            label="Error Rate"
            value={`${(stats.error_rate * 100).toFixed(1)}%`}
            icon={AlertTriangle}
            trend={stats.error_rate > 0.05 ? "down" : "neutral"}
          />
          <MetricCard
            label="Avg Cost"
            value={fmtCost(stats.avg_cost_usd)}
            subtitle={`Total: ${fmtCost(stats.total_cost_usd)}`}
            icon={DollarSign}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <select
          value={errorFilter === undefined ? "" : errorFilter ? "error" : "ok"}
          onChange={(e) => {
            const v = e.target.value;
            setErrorFilter(
              v === "error" ? true : v === "ok" ? false : undefined,
            );
            setOffset(0);
          }}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        >
          <option value="">All statuses</option>
          <option value="ok">Success only</option>
          <option value="error">Errors only</option>
        </select>
        <input
          placeholder="Filter by task type"
          value={taskType}
          onChange={(e) => {
            setTaskType(e.target.value);
            setOffset(0);
          }}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        />
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : traces.length === 0 ? (
        <EmptyState title="No traces recorded" />
      ) : (
        <>
          <DataTable
            columns={[
              { key: "_time", label: "Time", sortable: true },
              { key: "user_id", label: "User" },
              { key: "_query", label: "Query", className: "max-w-xs truncate" },
              { key: "_duration", label: "Duration", sortable: true },
              { key: "total_tokens", label: "Tokens", sortable: true },
              { key: "_cost", label: "Cost", sortable: true },
              { key: "difficulty", label: "Difficulty", sortable: true },
              {
                key: "_status",
                label: "Status",
                render: (row: Record<string, unknown>) => (
                  <StatusBadge status={row._status as "ok" | "error"} />
                ),
              },
              { key: "_critic", label: "Critic" },
            ]}
            data={enriched}
            keyField="trace_id"
            onRowClick={(r) => navigate(`/traces/${r.trace_id}`)}
          />
          <div className="flex items-center gap-2">
            <button
              disabled={offset <= 0}
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50 dark:border-gray-600"
            >
              Previous
            </button>
            <span className="py-1 text-sm text-gray-500">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              disabled={offset + limit >= total}
              onClick={() => setOffset((o) => o + limit)}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50 dark:border-gray-600"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
