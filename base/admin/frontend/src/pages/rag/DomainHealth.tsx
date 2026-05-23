import { useParams } from "react-router-dom";
import { useQualityDomain } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

function formatCount(value?: number | null) {
  return (value ?? 0).toLocaleString();
}

function formatPct(value?: number | null) {
  if (value == null) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function formatScore(value?: number | null) {
  return value == null ? "—" : value.toFixed(2);
}

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
        <h1 className="text-2xl font-semibold text-gray-900">{data.display_name ?? data.pack_id ?? data.domain}</h1>
        <p className="mt-1 text-sm text-gray-500">{data.path}</p>
        <div className="mt-2"><StatusBadge status={data.health} /></div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <MetricCard label="Content Nodes" value={formatCount(data.inventory?.total_chunks)} />
        <MetricCard label="Graph Nodes" value={formatCount(data.node_count ?? data.inventory?.total_nodes)} />
        <MetricCard label="Embeddings" value={formatCount(data.embedding_count)} subtitle={formatPct(data.embedding_coverage ?? data.coverage?.hit_rate)} />
        <MetricCard label="Edges" value={formatCount(data.edge_count)} />
        <MetricCard label="Documents" value={formatCount(data.inventory?.total_documents)} />
        <MetricCard label="Sources" value={formatCount(data.inventory?.total_sources)} />
        <MetricCard label="Quality" value={formatScore(data.quality_score ?? data.coverage?.mean_mrr)} />
        <MetricCard label="Trust" value={formatScore(data.trust_score)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <MetricCard label="Examples" value={formatCount(data.example_count)} />
        <MetricCard label="Context Cards" value={formatCount(data.context_card_count)} />
        <MetricCard label="Constraints" value={formatCount(data.constraint_count)} />
        <MetricCard label="External Refs" value={formatCount(data.external_ref_count)} />
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
