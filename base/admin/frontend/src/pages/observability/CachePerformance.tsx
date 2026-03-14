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
import { Database, Zap, Target, Trash2 } from "lucide-react";

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Cache Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Retrieval cache hit rates, key counts, and evictions
        </p>
      </div>

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
      )}
    </div>
  );
}
