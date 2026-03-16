import { useCircuitBreakers } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

const CATEGORY_LABELS: Record<string, string> = {
  llm: "LLM Models",
  web_search: "Web Search",
  infrastructure: "Infrastructure",
};

function groupByCategory(breakers: { name: string; category?: string }[]) {
  const groups: Record<string, typeof breakers> = {
    llm: [],
    web_search: [],
    infrastructure: [],
  };
  for (const b of breakers) {
    const cat = b.category ?? "infrastructure";
    if (cat in groups) groups[cat].push(b);
    else groups.infrastructure.push(b);
  }
  return groups;
}

export default function CircuitBreakers() {
  const { data, isLoading } = useCircuitBreakers();
  const breakers = data?.breakers ?? [];
  const grouped = groupByCategory(breakers);
  const categoryOrder = ["llm", "web_search", "infrastructure"] as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Circuit Breakers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-service circuit breaker states and trip counts
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : breakers.length === 0 ? (
        <EmptyState title="No circuit breaker data" />
      ) : (
        <div className="space-y-6">
          {categoryOrder.map((cat) => {
            const items = grouped[cat];
            if (!items.length) return null;
            return (
              <div key={cat}>
                <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
                  {CATEGORY_LABELS[cat]}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((b) => (
                    <div key={b.name} className="rounded-lg border border-gray-200 bg-white p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-900">{b.name}</span>
                        <StatusBadge status={b.state} />
                      </div>
                      <p className="mt-1 text-xs text-gray-500">Trips: {b.trips}</p>
                      {b.last_trip && <p className="text-xs text-gray-400">Last: {b.last_trip}</p>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
