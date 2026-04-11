import { useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  useCriticDetailed,
  useCriticEvaluations,
  useCriticModels,
  useRunCritic,
  usePurgeTrivialTraces,
  useClearCriticData,
} from "../../api/hooks";
import type { CriticEvaluation, CriticRunResult } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import {
  CheckCircle,
  XCircle,
  BarChart3,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Play,
  Trash2,
  Loader2,
} from "lucide-react";

const COLORS = ["#22c55e", "#ef4444"];

const TIME_RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
] as const;

export default function CriticAnalytics() {
  const [days, setDays] = useState(7);
  const { data, isLoading } = useCriticDetailed(days);
  const purgeMutation = usePurgeTrivialTraces();

  const handlePurge = (dryRun: boolean) => {
    purgeMutation.mutate({ min_tokens: 100, dry_run: dryRun });
  };

  const timeRangeButtons = (
    <div className="flex flex-wrap gap-2">
      {TIME_RANGES.map(({ label, days: d }) => (
        <button
          key={d}
          type="button"
          onClick={() => setDays(d)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            days === d
              ? "bg-indigo-100 text-indigo-700"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => handlePurge(true)}
        disabled={purgeMutation.isPending}
        className="inline-flex items-center gap-1 rounded-md bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
        title="Preview trivial traces (< 100 tokens) that would be removed"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {purgeMutation.isPending ? "Checking..." : "Purge Trivial"}
      </button>
    </div>
  );

  const purgeResult = purgeMutation.data ? (
    <div className="rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
      {purgeMutation.data.dry_run ? (
        <>
          Found <strong>{purgeMutation.data.would_delete}</strong> trivial traces
          (&lt;{100} tokens).{" "}
          {(purgeMutation.data.would_delete ?? 0) > 0 && (
            <button
              onClick={() => handlePurge(false)}
              className="ml-2 rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Delete them
            </button>
          )}
        </>
      ) : (
        <>Deleted <strong>{purgeMutation.data.deleted}</strong> trivial traces.</>
      )}
    </div>
  ) : null;

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data || data.total_evaluated === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              Critic Analytics
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Approval rates, rejection reasons, and scoring
            </p>
          </div>
          {timeRangeButtons}
        </div>
        {purgeResult}
        <EmptyState
          title="No critic data"
          description={data ? `No evaluations in the last ${days} day(s)` : "Critic metrics will appear after evaluations run"}
        />
      </div>
    );
  }

  const avgScore =
    data.avg_scores?.weighted_overall ?? 0;
  const pieData = [
    { name: "Approved", value: data.approved },
    { name: "Rejected", value: data.rejected },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Critic Analytics
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Approval rates, rejection reasons, and scoring
          </p>
        </div>
        {timeRangeButtons}
      </div>

      {purgeResult}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Evaluations"
          value={data.total_evaluated}
          icon={BarChart3}
        />
        <MetricCard
          label="Approval Rate"
          value={`${(data.approval_rate * 100).toFixed(1)}%`}
          icon={CheckCircle}
        />
        <MetricCard
          label="Avg Score"
          value={avgScore.toFixed(2)}
        />
        <MetricCard
          label="Blocking Issues"
          value={data.rejected}
          icon={data.rejected > 0 ? AlertTriangle : XCircle}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {pieData.length > 0 && (
          <ChartCard title="Approval Distribution">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                  }
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {data.score_distribution && data.score_distribution.some((b) => b.count > 0) && (
          <ChartCard title="Score Distribution">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.score_distribution}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {data.top_failure_modes && data.top_failure_modes.length > 0 && (
        <ChartCard title="Top Failure Modes">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Mode
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Count
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.top_failure_modes.map((row) => (
                  <tr key={row.mode}>
                    <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-900">
                      {row.mode}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-sm text-gray-600">
                      {row.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}

      {data.rejection_reasons && data.rejection_reasons.length > 0 && (
        <ChartCard title="Recent Rejections">
          <div className="space-y-3">
            {data.rejection_reasons.map((r) => (
              <div
                key={r.trace_id}
                className="rounded-md border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/traces/${r.trace_id}`}
                    className="font-mono text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {r.trace_id}
                  </Link>
                  <span className="text-sm text-gray-500">
                    Score: {r.score.toFixed(2)}
                  </span>
                  {r.failure_modes.length > 0 && (
                    <span className="text-xs text-gray-500">
                      ({r.failure_modes.join(", ")})
                    </span>
                  )}
                </div>
                {r.query_snippet && (
                  <p className="mt-1 truncate text-sm text-gray-600 dark:text-gray-400">
                    {r.query_snippet}
                  </p>
                )}
              </div>
            ))}
          </div>
        </ChartCard>
      )}

      <EvaluationsTable days={days} />

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Critic Configuration
        </h3>
        <ul className="mt-2 space-y-1 text-xs text-gray-500">
          <li>
            <strong>Async critic:</strong> Enabled by default (runs after response delivery).
            Toggle via <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">SYNESIS_CRITIC_BACKGROUND=false</code> in the Chat (planner-ts) deployment.
          </li>
          <li>
            <strong>Manual critic:</strong> Use the <Play className="inline h-3 w-3" /> button on any evaluation to re-run the critic with a different model.
          </li>
          <li>
            <strong>Difficulty threshold:</strong> Critic is skipped for trivial prompts (difficulty &lt; 0.15).
            Lenient mode applies below 0.4.
          </li>
          <li>
            <strong>External models:</strong> Available when <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">OPENROUTER_API_KEY</code> is set on the admin service.
          </li>
        </ul>
      </div>
    </div>
  );
}

function EvaluationsTable({ days }: { days: number }) {
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("synesis-critic");
  const [runResult, setRunResult] = useState<CriticRunResult | null>(null);
  const pageSize = 25;
  const { data, isLoading } = useCriticEvaluations({
    days,
    limit: pageSize,
    offset: page * pageSize,
  });
  const { data: modelData } = useCriticModels();
  const runCritic = useRunCritic();
  const clearCritic = useClearCriticData();

  const evaluations = data?.evaluations ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const models = modelData?.models ?? [];

  const handleRunCritic = (traceId: string) => {
    runCritic.mutate(
      { trace_id: traceId, model: selectedModel },
      { onSuccess: (result) => setRunResult(result) },
    );
  };

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Individual Evaluations ({total})
        </h2>
        {models.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Critic model:</span>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {runResult && (
        <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-900/20">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
              Critic Result — {runResult.model_label}
            </span>
            <button
              onClick={() => setRunResult(null)}
              className="text-xs text-indigo-500 hover:text-indigo-700"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <span className="font-medium">Score:</span>{" "}
              <span className={runResult.scores?.weighted_overall >= 7 ? "text-green-600" : "text-red-600"}>
                {runResult.scores?.weighted_overall?.toFixed(1) ?? "N/A"}
              </span>
            </div>
            <div>
              <span className="font-medium">Status:</span>{" "}
              {runResult.approved ? (
                <span className="text-green-600">Approved</span>
              ) : (
                <span className="text-red-600">Rejected</span>
              )}
            </div>
            <div>
              <span className="font-medium">Latency:</span>{" "}
              {runResult.latency_ms}ms
            </div>
          </div>
          {runResult.failure_modes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {runResult.failure_modes.map((m) => (
                <span key={m} className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">{m}</span>
              ))}
            </div>
          )}
          {runResult.overall_assessment && (
            <p className="mt-2 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
              {runResult.overall_assessment}
            </p>
          )}
        </div>
      )}
      {isLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : evaluations.length === 0 ? (
        <p className="text-sm text-gray-500">No evaluations found.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Trace
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Query
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium uppercase text-gray-500">
                    Score
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium uppercase text-gray-500">
                    Status
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">
                    Failure Modes
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {evaluations.map((ev: CriticEvaluation) => (
                  <EvalRow
                    key={ev.trace_id}
                    ev={ev}
                    expanded={expanded === ev.trace_id}
                    onToggle={() =>
                      setExpanded(expanded === ev.trace_id ? null : ev.trace_id)
                    }
                    onRunCritic={() => handleRunCritic(ev.trace_id)}
                    onClearCritic={() => {
                      if (confirm(`Clear critic data for ${ev.trace_id.slice(0, 12)}...? The trace itself will be preserved.`)) {
                        clearCritic.mutate(ev.trace_id);
                      }
                    }}
                    isRunning={runCritic.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm text-gray-500">
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EvalRow({
  ev,
  expanded,
  onToggle,
  onRunCritic,
  onClearCritic,
  isRunning,
}: {
  ev: CriticEvaluation;
  expanded: boolean;
  onToggle: () => void;
  onRunCritic: () => void;
  onClearCritic: () => void;
  isRunning: boolean;
}) {
  const scoreColor =
    ev.weighted_overall >= 7
      ? "text-green-600 dark:text-green-400"
      : ev.weighted_overall >= 5
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-red-600 dark:text-red-400";

  return (
    <>
      <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
        <td className="px-4 py-2">
          <Link
            to={`/traces/${ev.trace_id}`}
            className="font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {ev.trace_id.slice(0, 12)}...
          </Link>
        </td>
        <td className="max-w-xs truncate px-4 py-2 text-sm text-gray-700 dark:text-gray-300">
          {ev.query_snippet || "—"}
        </td>
        <td className={`px-4 py-2 text-center text-sm font-semibold ${scoreColor}`}>
          {ev.weighted_overall.toFixed(1)}
        </td>
        <td className="px-4 py-2 text-center">
          {ev.approved ? (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              Approved
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
              Rejected
            </span>
          )}
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-wrap gap-1">
            {ev.failure_modes.slice(0, 3).map((m) => (
              <span
                key={m}
                className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              >
                {m}
              </span>
            ))}
            {ev.failure_modes.length > 3 && (
              <span className="text-xs text-gray-400">
                +{ev.failure_modes.length - 3}
              </span>
            )}
          </div>
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-1">
            <button
              onClick={onRunCritic}
              disabled={isRunning}
              className="rounded p-1 text-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-40 dark:hover:bg-indigo-900/30"
              title="Run critic on this trace"
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={onClearCritic}
              className="rounded p-1 text-amber-400 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-900/30"
              title="Clear critic data (keeps trace)"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onToggle}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-gray-50 px-4 py-3 dark:bg-gray-800/80">
            <div className="space-y-2 text-sm">
              {ev.failure_modes.length > 0 && (
                <div>
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    All failure modes:{" "}
                  </span>
                  <span className="text-gray-600 dark:text-gray-400">
                    {ev.failure_modes.join(", ")}
                  </span>
                </div>
              )}
              {ev.repair_instructions && (
                <div>
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    Repair instructions:{" "}
                  </span>
                  <span className="whitespace-pre-wrap text-gray-600 dark:text-gray-400">
                    {ev.repair_instructions}
                  </span>
                </div>
              )}
              <div>
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  Time:{" "}
                </span>
                <span className="text-gray-600 dark:text-gray-400">
                  {new Date(ev.timestamp * 1000).toLocaleString()}
                </span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
