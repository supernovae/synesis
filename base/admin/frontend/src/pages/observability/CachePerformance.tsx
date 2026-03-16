import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCacheMetrics } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { Database, Zap, Target, Trash2, Server, Key, Archive } from "lucide-react";

const COLORS = ["#22c55e", "#3b82f6", "#ef4444"];

export default function CachePerformance() {
  const { data, isLoading } = useCacheMetrics();

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Cache Performance</h1>
          <p className="mt-1 text-sm text-gray-500">Retrieval cache metrics</p>
        </div>
        <EmptyState title="No cache data" icon={Database} />
      </div>
    );
  }

  const pieData = [
    { name: "Exact Hits", value: data.exact_hits },
    { name: "Semantic Hits", value: data.semantic_hits },
    { name: "Misses", value: data.misses },
  ].filter((d) => d.value > 0);

  const redis = data.redis;
  const session = data.session;
  const l2Archive = data.l2_archive;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Cache Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Retrieval cache hit rates, key counts, evictions, Redis, and session/L2 status
        </p>
      </div>

      {/* Retrieval cache section */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Retrieval Cache
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Hit Rate"
            value={`${(data.hit_rate * 100).toFixed(1)}%`}
            icon={Target}
          />
          <MetricCard label="Exact Hits" value={data.exact_hits} icon={Zap} />
          <MetricCard
            label="Semantic Hits"
            value={data.semantic_hits}
            icon={Database}
          />
          <MetricCard label="Misses" value={data.misses} />
          <MetricCard
            label="Evictions"
            value={data.evictions}
            icon={Trash2}
          />
          <MetricCard label="Entries" value={data.entries} icon={Database} />
        </div>

        {pieData.length > 0 && (
          <div className="mt-4">
            <ChartCard title="Cache Distribution" subtitle="Hits vs misses">
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
          </div>
        )}
      </div>

      {/* Redis section */}
      {redis && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Redis
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Status"
              value={
                redis.status === "connected"
                  ? "Connected"
                  : redis.status === "not_configured"
                    ? "Not Configured"
                    : redis.status === "error"
                      ? `Error: ${(redis as { error?: string }).error ?? "unknown"}`
                      : redis.status
              }
              icon={Server}
            />
            {redis.used_memory_human != null && (
              <MetricCard label="Memory" value={redis.used_memory_human} icon={Database} />
            )}
            {redis.keyspace_hit_rate != null && (
              <MetricCard
                label="Keyspace Hit Rate"
                value={`${(redis.keyspace_hit_rate * 100).toFixed(1)}%`}
                icon={Target}
              />
            )}
            {redis.total_keys != null && (
              <MetricCard label="Total Keys" value={redis.total_keys} icon={Key} />
            )}
          </div>
        </div>
      )}

      {/* Session & L2 section */}
      {(session || l2Archive) && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Session & L2
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {session && (
              <MetricCard
                label="Session Backend"
                value={session.backend}
                icon={Key}
              />
            )}
            {l2Archive && (
              <MetricCard
                label="L2 Archive"
                value={l2Archive.configured ? "Configured" : "Not Configured"}
                icon={Archive}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
