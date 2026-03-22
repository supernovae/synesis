import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { clsx } from "clsx";
import { Activity, Clock, Coins } from "lucide-react";
import { useYarnPerformance, type YarnPerformanceBucket } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

const BUCKET_OPTIONS = [
  { label: "5m", minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "60m", minutes: 60 },
];

function fmtBucketLabel(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function summarize(buckets: YarnPerformanceBucket[]) {
  let requests = 0;
  let cost = 0;
  let latW = 0;
  for (const b of buckets) {
    requests += b.requests;
    cost += b.cost_usd;
    latW += b.avg_latency_ms * b.requests;
  }
  return {
    requests,
    cost,
    avgLatencyMs: requests > 0 ? latW / requests : 0,
  };
}

export default function YarnPerformance() {
  const [sinceHours, setSinceHours] = useState(24);
  const [bucketMinutes, setBucketMinutes] = useState(15);
  const { data, isLoading } = useYarnPerformance(sinceHours, bucketMinutes);

  const buckets = data ?? [];
  const chartData = useMemo(
    () =>
      buckets.map((b) => ({
        ...b,
        label: fmtBucketLabel(b.bucket),
      })),
    [buckets],
  );

  const summary = useMemo(() => summarize(buckets), [buckets]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Performance
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Bucketed requests, latency, cost, and token volume
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.hours}
                type="button"
                onClick={() => setSinceHours(opt.hours)}
                className={clsx(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  sinceHours === opt.hours
                    ? "bg-indigo-600 text-white"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>Bucket</span>
            <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
              {BUCKET_OPTIONS.map((opt) => (
                <button
                  key={opt.minutes}
                  type="button"
                  onClick={() => setBucketMinutes(opt.minutes)}
                  className={clsx(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    bucketMinutes === opt.minutes
                      ? "bg-indigo-600 text-white"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {isLoading && !data ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : chartData.length === 0 ? (
        <EmptyState title="No performance samples" description="No usage rows in this period for the selected bucket size." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Requests (window)"
              value={summary.requests.toLocaleString()}
              icon={Activity}
            />
            <MetricCard
              label="Avg latency (weighted)"
              value={fmtDurationMs(summary.avgLatencyMs)}
              icon={Clock}
            />
            <MetricCard
              label="Total cost (window)"
              value={fmtCost(summary.cost)}
              icon={Coins}
            />
          </div>

          <ChartCard title="Requests over time" subtitle="Count per bucket">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="requests"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <ChartCard title="Average latency over time" subtitle="Mean latency ms per bucket">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: number) => [`${v.toFixed(1)} ms`, "Avg latency"]} />
                  <Line
                    type="monotone"
                    dataKey="avg_latency_ms"
                    stroke="#0d9488"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <ChartCard
            title="Cost & token volume"
            subtitle="Stacked prompt/completion tokens (left) and cost USD (right)"
          >
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                    tickFormatter={(v) => fmtTokens(Number(v))}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value: number, name: string) => {
                      if (name === "cost_usd") return [fmtCost(value), "Cost"];
                      return [fmtTokens(value), name];
                    }}
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="tokens_in"
                    stackId="tok"
                    fill="#6366f1"
                    stroke="#4f46e5"
                    name="tokens_in"
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="tokens_out"
                    stackId="tok"
                    fill="#a5b4fc"
                    stroke="#818cf8"
                    name="tokens_out"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cost_usd"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    name="cost_usd"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </>
      )}
    </div>
  );
}
