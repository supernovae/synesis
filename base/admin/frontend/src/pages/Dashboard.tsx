import { Link } from "react-router-dom";
import { Activity, Layers, Database, Zap, DollarSign } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import MetricCard from "../components/common/MetricCard";
import ChartCard from "../components/common/ChartCard";
import EmptyState from "../components/common/EmptyState";
import StatusBadge from "../components/common/StatusBadge";
import { useDashboardSummary } from "../api/hooks";

const PIE_COLORS = ["#22c55e", "#f59e0b", "#ef4444", "#6b7280"];

export default function Dashboard() {
  const { data, isLoading } = useDashboardSummary();

  if (isLoading) return <DashboardSkeleton />;

  const m = data?.metrics;
  const services = data?.services ?? [];
  const healthy = services.filter((s) => s.status === "ok").length;
  const degraded = services.filter((s) => s.status === "degraded").length;
  const down = services.filter((s) => s.status === "error").length;

  const healthPie = [
    { name: "Healthy", value: healthy },
    { name: "Degraded", value: degraded },
    { name: "Down", value: down },
  ].filter((d) => d.value > 0);

  const latencyData = services
    .filter((s) => s.latency_ms != null)
    .map((s) => ({ name: s.name.replace("synesis-", ""), latency: s.latency_ms }))
    .sort((a, b) => (b.latency ?? 0) - (a.latency ?? 0));

  const costByRole = data?.monthly_fixed_cost_estimate?.by_role ?? {};
  const costData = Object.entries(costByRole).map(([role, usd]) => ({
    role,
    usd: Number(usd),
  }));
  const monthlyFixedTotal = data?.monthly_fixed_cost_estimate?.total_usd ?? 0;
  const hasMonthlyFixed = monthlyFixedTotal > 0;

  const pipeSpend =
    m?.pipeline_usage_estimated_spend_24h_usd ?? m?.trace_estimated_spend_24h_usd ?? 0;
  const yarnSpend = m?.yarn_usage_estimated_spend_24h_usd ?? 0;
  const platformSpend =
    m?.platform_usage_estimated_spend_24h_usd ?? pipeSpend + yarnSpend;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          System overview and key metrics
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <MetricCard
          label="Services"
          value={`${healthy}/${services.length}`}
          subtitle="healthy"
          icon={Activity}
        />
        <MetricCard
          label="Requests (24h)"
          value={m?.total_requests?.toLocaleString() ?? "---"}
          icon={Zap}
        />
        <MetricCard
          label="Active Models"
          value={m?.active_models ?? "---"}
          icon={Layers}
        />
        <MetricCard
          label="Cache Hit Rate"
          value={
            m?.cache_hit_rate != null
              ? `${(m.cache_hit_rate * 100).toFixed(1)}%`
              : "---"
          }
          icon={Database}
        />
        <MetricCard
          label="Traces (24h)"
          value={m?.traces_24h ?? "---"}
          subtitle="LangGraph pipeline rows only (excludes Coder traces)"
          icon={Activity}
        />
        <MetricCard
          label="Chat pipeline (24h)"
          value={`$${Number(pipeSpend).toFixed(4)}`}
          subtitle="estimated · planner_usage_log"
          icon={DollarSign}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Coder / IDE (24h)"
          value={`$${Number(yarnSpend).toFixed(4)}`}
          subtitle="estimated · yarn_usage_log"
          icon={DollarSign}
        />
        <MetricCard
          label="Platform usage (24h)"
          value={`$${Number(platformSpend).toFixed(4)}`}
          subtitle="pipeline + Coder (estimated)"
          icon={DollarSign}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Service Health" className="lg:col-span-1">
          {healthPie.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={healthPie}
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={70}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {healthPie.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length] ?? "#64748b"} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-sm text-gray-400">No data</p>
          )}
        </ChartCard>

        <ChartCard
          title="Service Latency"
          subtitle="Response time in ms"
          className="lg:col-span-2"
        >
          {latencyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={latencyData} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={90}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip formatter={(v) => (v == null ? "" : `${Number(v).toFixed(0)}ms`)} />
                <Bar dataKey="latency" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-sm text-gray-400">No data</p>
          )}
        </ChartCard>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-medium text-gray-900">
          All Services
        </h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {services.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2"
            >
              <div>
                <span className="text-sm text-gray-700">{s.name}</span>
                {s.latency_ms != null && (
                  <span className="ml-2 text-xs text-gray-400">
                    {s.latency_ms.toFixed(0)}ms
                  </span>
                )}
              </div>
              <StatusBadge status={s.status as "ok" | "error" | "degraded"} />
            </div>
          ))}
        </div>
      </div>

      <ChartCard
        title="Monthly fixed (infra) by role"
        subtitle="From model cost registry — not the same as 24h usage above"
      >
        {hasMonthlyFixed ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={costData}>
              <XAxis dataKey="role" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => (v == null ? "" : `$${Number(v).toFixed(2)}`)} />
              <Bar dataKey="usd" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="py-4">
            <EmptyState
              title="No monthly fixed costs configured"
              description="Set monthly_fixed_cost on model cost entries or infra settings so this chart reflects fixed infrastructure estimates."
            />
            <p className="mt-3 text-center">
              <Link
                to="/models/costs"
                className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open cost tracker
              </Link>
            </p>
          </div>
        )}
      </ChartCard>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          System overview and key metrics
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-lg border border-gray-200 bg-gray-100"
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {[1, 2].map((i) => (
          <div
            key={i}
            className={`h-56 animate-pulse rounded-lg bg-gray-100 ${i === 2 ? "lg:col-span-2" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}
