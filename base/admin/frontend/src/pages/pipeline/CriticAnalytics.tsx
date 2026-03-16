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
import { useCriticDetailed } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { CheckCircle, XCircle, BarChart3, AlertTriangle } from "lucide-react";

const COLORS = ["#22c55e", "#ef4444"];

const TIME_RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
] as const;

export default function CriticAnalytics() {
  const [days, setDays] = useState(7);
  const { data, isLoading } = useCriticDetailed(days);

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              Critic Analytics
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Approval rates, rejection reasons, and scoring
            </p>
          </div>
          <div className="flex gap-2">
            {TIME_RANGES.map(({ label, days: d }) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  days === d
                    ? "bg-indigo-100 text-indigo-700"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <EmptyState
          title="No critic data"
          description="Critic metrics will appear after evaluations run"
        />
      </div>
    );
  }

  if (data.total_evaluated === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Critic Analytics
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Approval rates, rejection reasons, and scoring
          </p>
        </div>
        <div className="flex gap-2">
          {TIME_RANGES.map(({ label, days: d }) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                days === d
                  ? "bg-indigo-100 text-indigo-700"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <EmptyState
          title="No critic data"
          description={`No evaluations in the last ${days} day(s)`}
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
          <h1 className="text-2xl font-semibold text-gray-900">
            Critic Analytics
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Approval rates, rejection reasons, and scoring
          </p>
        </div>
        <div className="flex gap-2">
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
        </div>
      </div>

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
                    `${name} ${(percent * 100).toFixed(0)}%`
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
                className="rounded-md border border-gray-200 bg-gray-50/50 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/traces/${r.trace_id}`}
                    className="font-mono text-sm font-medium text-indigo-600 hover:underline"
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
                  <p className="mt-1 truncate text-sm text-gray-600">
                    {r.query_snippet}
                  </p>
                )}
              </div>
            ))}
          </div>
        </ChartCard>
      )}
    </div>
  );
}
