import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useTraces,
  useTraceStats,
  useDeleteTrace,
  usePurgeTrivialTraces,
  useBulkDeleteTraces,
} from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { Activity, Clock, DollarSign, AlertTriangle, Trash2, Building2 } from "lucide-react";
import { Link } from "react-router-dom";

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
  const [orgFilter, setOrgFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purgeThreshold, setPurgeThreshold] = useState(100);
  const [maxTokensFilter, setMaxTokensFilter] = useState<number | undefined>(undefined);
  const [hallucinationFilter, setHallucinationFilter] = useState(false);
  const [serviceFilter, setServiceFilter] = useState<"planner" | "yarn" | "all">("planner");
  const limit = 30;

  const { data, isLoading } = useTraces({
    offset,
    limit,
    has_error: errorFilter,
    task_type: taskType || undefined,
    org_id: orgFilter || undefined,
    max_tokens: maxTokensFilter,
    min_hallucinated_urls: hallucinationFilter ? 1 : undefined,
    trace_service: serviceFilter,
  });
  const { data: stats } = useTraceStats();
  const deleteTrace = useDeleteTrace();
  const purgeMutation = usePurgeTrivialTraces();
  const bulkDelete = useBulkDeleteTraces();
  const traces = useMemo(() => data?.traces ?? [], [data]);
  const total = data?.total ?? 0;

  const enriched = useMemo(
    () =>
      traces.map((t) => ({
        ...t,
        _time: fmtDate(t.timestamp),
        _duration: fmtDuration(t.total_duration_ms),
        _cost: fmtCost(t.estimated_cost_usd),
        _query: t.query_snippet?.slice(0, 80) || "—",
        _status: t.has_error ? "error" : "ok",
        _critic: t.critic_scores?.weighted_overall
          ? `${Number(t.critic_scores.weighted_overall).toFixed(1)}`
          : "—",
      })),
    [traces],
  );

  const visibleIds = useMemo(() => new Set(traces.map((t) => t.trace_id as string)), [traces]);
  const allSelected = visibleIds.size > 0 && [...visibleIds].every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  }, [allSelected, visibleIds]);

  const handleBulkDelete = useCallback(() => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected trace(s)?`)) return;
    bulkDelete.mutate(ids, {
      onSuccess: () => setSelected(new Set()),
    });
  }, [selected, bulkDelete]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            LLM Traces
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Operator observability: full prompts and spans. For billing totals use{" "}
            <Link to="/account/usage" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              Account usage
            </Link>{" "}
            /{" "}
            <Link to="/models/overview" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              Models overview
            </Link>
            . Table cost column is <span className="font-medium">estimated</span> (registry rates).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {someSelected && (
            <button
              onClick={handleBulkDelete}
              disabled={bulkDelete.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {bulkDelete.isPending
                ? "Deleting..."
                : `Delete ${selected.size} selected`}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <select
              value={purgeThreshold}
              onChange={(e) => setPurgeThreshold(Number(e.target.value))}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              title="Token threshold for trivial traces"
            >
              <option value={50}>&lt;50 tok</option>
              <option value={100}>&lt;100 tok</option>
              <option value={200}>&lt;200 tok</option>
              <option value={500}>&lt;500 tok</option>
            </select>
            <button
              onClick={() =>
                purgeMutation.mutate({
                  min_tokens: purgeThreshold,
                  dry_run: true,
                })
              }
              disabled={purgeMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {purgeMutation.isPending ? "Scanning..." : "Purge Trivial"}
            </button>
          </div>
        </div>
      </div>

      {purgeMutation.data && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {purgeMutation.data.dry_run ? (
            <>
              Found <strong>{purgeMutation.data.would_delete}</strong> trivial
              traces (&lt;{purgeMutation.data.min_tokens ?? purgeThreshold} tokens).{" "}
              {(purgeMutation.data.would_delete ?? 0) > 0 && (
                <button
                  onClick={() =>
                    purgeMutation.mutate({
                      min_tokens: purgeMutation.data?.min_tokens ?? purgeThreshold,
                      dry_run: false,
                    })
                  }
                  className="ml-2 rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700"
                >
                  Delete them
                </button>
              )}
            </>
          ) : (
            <>
              Deleted <strong>{purgeMutation.data.deleted}</strong> trivial
              traces (&lt;{purgeMutation.data.min_tokens ?? purgeThreshold} tokens).
            </>
          )}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard
            label="Traces (24h)"
            value={stats.total_traces_24h}
            subtitle="pipeline rows only (excl. Yarn)"
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
            label="Avg cost (est.)"
            value={fmtCost(stats.avg_cost_usd)}
            subtitle={`Total est.: ${fmtCost(stats.total_cost_usd)} · trace rows`}
            icon={DollarSign}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(
          [
            { id: "planner" as const, label: "Pipeline (LangGraph)" },
            { id: "yarn" as const, label: "Yarn" },
            { id: "all" as const, label: "All" },
          ]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setServiceFilter(tab.id);
              setOffset(0);
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              serviceFilter === tab.id
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 text-gray-400" />
          <input
            placeholder="Filter by org"
            value={orgFilter}
            onChange={(e) => {
              setOrgFilter(e.target.value);
              setOffset(0);
            }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          />
        </div>
        <button
          onClick={() => {
            setHallucinationFilter((v) => !v);
            setOffset(0);
          }}
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
            hallucinationFilter
              ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
          }`}
        >
          Hallucinated URLs
        </button>
        <span className="text-xs text-gray-400 dark:text-gray-500">Quick:</span>
        {[
          { label: "All tokens", value: undefined },
          { label: "<50 tok", value: 50 },
          { label: "<100 tok", value: 100 },
          { label: "<200 tok", value: 200 },
        ].map((chip) => (
          <button
            key={chip.label}
            onClick={() => {
              setMaxTokensFilter(chip.value);
              setOffset(0);
            }}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              maxTokensFilter === chip.value
                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : traces.length === 0 ? (
        <EmptyState title="No traces recorded" />
      ) : (
        <>
          <DataTable
            columns={[
              {
                key: "_select",
                label: "",
                render: (row: Record<string, unknown>) => (
                  <input
                    type="checkbox"
                    checked={selected.has(row.trace_id as string)}
                    onChange={(e) => {
                      e.stopPropagation();
                      toggleOne(row.trace_id as string);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                ),
                className: "w-10",
              },
              { key: "_time", label: "Time", sortable: true },
              {
                key: "_user_display",
                label: "User",
                render: (row: Record<string, unknown>) => {
                  const orgName = row.org_name as string | undefined;
                  return (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{(row.user_email as string) || (row.user_id as string) || "—"}</span>
                      {orgName && (
                        <span className="flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400">
                          <Building2 className="h-3 w-3" />
                          {orgName}
                        </span>
                      )}
                    </div>
                  );
                },
              },
              {
                key: "_query",
                label: "Query",
                className: "max-w-xs truncate",
              },
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
              {
                key: "_actions",
                label: "",
                render: (row: Record<string, unknown>) => (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        confirm(
                          `Delete trace ${String(row.trace_id).slice(0, 12)}…?`,
                        )
                      ) {
                        deleteTrace.mutate(row.trace_id as string);
                      }
                    }}
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                    title="Delete trace"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ),
              },
            ]}
            data={enriched}
            keyField="trace_id"
            onRowClick={(r) => navigate(`/traces/${r.trace_id}`)}
            headerSlot={
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el)
                      el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
              </th>
            }
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
