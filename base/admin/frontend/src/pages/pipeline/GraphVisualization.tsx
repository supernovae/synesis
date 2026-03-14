import { usePipelineGraph } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

export default function GraphVisualization() {
  const { data, isLoading } = usePipelineGraph();

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Graph Visualization
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          LangGraph orchestration pipeline flow
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : nodes.length === 0 ? (
        <EmptyState title="No graph data" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-center gap-4">
            {nodes.map((node, i) => (
              <div key={node.id} className="flex items-center gap-3">
                <div className="rounded-lg border-2 border-blue-200 bg-blue-50 px-4 py-2.5">
                  <span className="text-sm font-medium text-blue-900">
                    {node.label}
                  </span>
                </div>
                {i < nodes.length - 1 && (
                  <svg width="32" height="20" className="text-gray-300">
                    <line x1="0" y1="10" x2="24" y2="10" stroke="currentColor" strokeWidth="2" />
                    <polygon points="24,5 32,10 24,15" fill="currentColor" />
                  </svg>
                )}
              </div>
            ))}
          </div>

          <div className="mt-6 space-y-2">
            <h4 className="text-xs font-medium uppercase text-gray-500">
              Edges
            </h4>
            {edges.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">{e.from}</span>
                <span className="text-gray-400">&rarr;</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">{e.to}</span>
                {e.label && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                    {e.label}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
