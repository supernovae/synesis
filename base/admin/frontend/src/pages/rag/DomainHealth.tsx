import { useParams } from "react-router-dom";
import { useQualityDomain } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

export default function DomainHealth() {
  const { key } = useParams<{ key: string }>();
  const { data, isLoading } = useQualityDomain(key ?? "");

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data) {
    return <EmptyState title="Domain not found" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{data.domain}</h1>
        <p className="mt-1 text-sm text-gray-500">{data.path}</p>
        <div className="mt-2"><StatusBadge status={data.health} /></div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <MetricCard label="Total Chunks" value={data.inventory?.total_chunks ?? 0} />
        <MetricCard label="Documents" value={data.inventory?.total_documents ?? 0} />
        <MetricCard label="Hit Rate" value={`${((data.coverage?.hit_rate ?? 0) * 100).toFixed(1)}%`} />
        <MetricCard label="Mean MRR" value={(data.coverage?.mean_mrr ?? 0).toFixed(3)} />
      </div>

      {data.dead_weight?.unretrieved_documents > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            <strong>{data.dead_weight.unretrieved_documents}</strong> documents were never retrieved in coverage tests.
          </p>
        </div>
      )}
    </div>
  );
}
