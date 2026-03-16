import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useServiceHealth } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import ChartCard from "../../components/common/ChartCard";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { Activity, CheckCircle, AlertTriangle, XCircle } from "lucide-react";

export default function ServiceHealth() {
  const { data, isLoading } = useServiceHealth();
  const services = data?.services ?? [];

  const healthy = services.filter((s) => s.status === "ok").length;
  const degraded = services.filter((s) => s.status === "degraded").length;
  const down = services.filter((s) => s.status === "error").length;

  const latencyData = services
    .filter((s) => s.latency_ms != null)
    .map((s) => ({
      name: s.name.replace("synesis-", ""),
      latency: s.latency_ms,
    }))
    .sort((a, b) => (b.latency ?? 0) - (a.latency ?? 0));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Service Health</h1>
        <p className="mt-1 text-sm text-gray-500">
          Live health probes for all platform services
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : services.length === 0 ? (
        <EmptyState title="No services" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Total" value={services.length} icon={Activity} />
            <MetricCard label="Healthy" value={healthy} icon={CheckCircle} />
            <MetricCard label="Degraded" value={degraded} icon={AlertTriangle} />
            <MetricCard label="Down" value={down} icon={XCircle} />
          </div>

          <ChartCard title="Response Latency" subtitle="Milliseconds per service">
            <ResponsiveContainer width="100%" height={Math.max(200, latencyData.length * 35)}>
              <BarChart data={latencyData} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `${v.toFixed(0)}ms`} />
                <Bar dataKey="latency" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="space-y-6">
            {[
              {
                category: "infrastructure" as const,
                title: "Infrastructure",
                services: services.filter((s) => s.category === "infrastructure" || !s.category),
              },
              {
                category: "model-gateway" as const,
                title: "Model Gateway",
                services: services.filter((s) => s.category === "model-gateway"),
              },
              {
                category: "model" as const,
                title: "Models",
                services: services.filter((s) => s.category === "model"),
              },
            ]
              .filter((sec) => sec.services.length > 0)
              .map((section) => (
                <div key={section.category}>
                  <h2 className="mb-3 text-sm font-medium text-gray-700">
                    {section.title}
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {section.services.map((s, i) => (
                      <div
                        key={`${section.category}-${s.name}-${i}`}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-900">
                            {s.name}
                          </span>
                          <StatusBadge status={s.status as "ok" | "error" | "degraded"} />
                        </div>
                        <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                          {s.latency_ms != null && (
                            <span>Latency: {s.latency_ms.toFixed(0)}ms</span>
                          )}
                          {s.status_code != null && (
                            <span>HTTP {s.status_code}</span>
                          )}
                        </div>
                        {s.error && (
                          <p className="mt-1 truncate text-xs text-red-600">
                            {s.error}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
