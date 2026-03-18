import { usePipelineGraph } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

const NODE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  entry: { bg: "bg-slate-100 dark:bg-slate-800", border: "border-slate-300 dark:border-slate-600", text: "text-slate-800 dark:text-slate-200" },
  retrieval: { bg: "bg-blue-50 dark:bg-blue-900/30", border: "border-blue-300 dark:border-blue-700", text: "text-blue-900 dark:text-blue-200" },
  planning: { bg: "bg-indigo-50 dark:bg-indigo-900/30", border: "border-indigo-300 dark:border-indigo-700", text: "text-indigo-900 dark:text-indigo-200" },
  execution: { bg: "bg-amber-50 dark:bg-amber-900/30", border: "border-amber-300 dark:border-amber-700", text: "text-amber-900 dark:text-amber-200" },
  generation: { bg: "bg-green-50 dark:bg-green-900/30", border: "border-green-300 dark:border-green-700", text: "text-green-900 dark:text-green-200" },
  validation: { bg: "bg-orange-50 dark:bg-orange-900/30", border: "border-orange-300 dark:border-orange-700", text: "text-orange-900 dark:text-orange-200" },
  evaluation: { bg: "bg-purple-50 dark:bg-purple-900/30", border: "border-purple-300 dark:border-purple-700", text: "text-purple-900 dark:text-purple-200" },
  post: { bg: "bg-teal-50 dark:bg-teal-900/30", border: "border-teal-300 dark:border-teal-700", text: "text-teal-900 dark:text-teal-200" },
  terminal: { bg: "bg-gray-100 dark:bg-gray-800", border: "border-gray-400 dark:border-gray-600", text: "text-gray-800 dark:text-gray-200" },
};

const ROWS: string[][] = [
  ["entry_pipeline"],
  ["router"],
  ["planner", "executor"],
  ["writer", "patch_integrity_gate"],
  ["critic"],
  ["final_scrubber"],
  ["respond"],
];

export default function GraphVisualization() {
  const { data, isLoading } = usePipelineGraph();
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Pipeline Graph
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          LangGraph orchestration pipeline — real node topology
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : nodes.length === 0 ? (
        <EmptyState title="No graph data" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-col items-center gap-4">
            {ROWS.map((rowIds, ri) => {
              const rowNodes = rowIds
                .map((id) => nodeMap[id])
                .filter(Boolean);
              if (rowNodes.length === 0) return null;
              return (
                <div key={ri} className="flex items-center gap-6">
                  {ri > 0 && (
                    <div className="absolute -mt-4">
                      <svg width="2" height="16" className="text-gray-300 dark:text-gray-600">
                        <line x1="1" y1="0" x2="1" y2="16" stroke="currentColor" strokeWidth="2" />
                      </svg>
                    </div>
                  )}
                  {rowNodes.map((node) => {
                    const colors = NODE_COLORS[node.type ?? ""] ?? NODE_COLORS.entry;
                    return (
                      <div
                        key={node.id}
                        className={`rounded-lg border-2 px-5 py-2.5 ${colors.bg} ${colors.border}`}
                      >
                        <span className={`text-sm font-semibold ${colors.text}`}>
                          {node.label}
                        </span>
                        {node.type && (
                          <span className="ml-2 text-xs text-gray-400">
                            ({node.type})
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="mt-8">
            <h4 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-500">
              Edge Map ({edges.length} transitions)
            </h4>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {edges.map((e, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded bg-gray-50 px-3 py-1.5 text-sm dark:bg-gray-800"
                >
                  <span className="rounded bg-gray-200 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                    {e.from}
                  </span>
                  <span className="text-gray-400">&rarr;</span>
                  <span className="rounded bg-gray-200 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                    {e.to}
                  </span>
                  {e.label && (
                    <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                      {e.label}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
