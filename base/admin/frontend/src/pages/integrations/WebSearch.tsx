import { useWebSearchStats } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { Search } from "lucide-react";

export default function WebSearch() {
  const { data, isLoading } = useWebSearchStats();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Web Search</h1>
        <p className="mt-1 text-sm text-gray-500">
          SearXNG web search integration stats
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : !data ? (
        <EmptyState title="No web search data" icon={Search} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard label="Total Searches" value={data.total ?? 0} icon={Search} />
          <MetricCard label="Avg Latency" value={data.avg_latency_ms ? `${data.avg_latency_ms.toFixed(0)}ms` : "---"} />
          <MetricCard label="Error Rate" value={data.error_rate ? `${(data.error_rate * 100).toFixed(1)}%` : "0%"} />
        </div>
      )}
    </div>
  );
}
