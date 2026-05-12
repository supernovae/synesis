import { useCircuitBreakers } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import type { CircuitBreakerState } from "../../types";

const CATEGORY_LABELS: Record<string, string> = {
  llm: "LLM Models",
  web_search: "Web Search",
  infrastructure: "Infrastructure",
};
type CircuitBreakerCategory = "llm" | "web_search" | "infrastructure";

function groupByCategory(breakers: CircuitBreakerState[]) {
  const groups: Record<CircuitBreakerCategory, CircuitBreakerState[]> = {
    llm: [],
    web_search: [],
    infrastructure: [],
  };
  for (const b of breakers) {
    const cat = b.category ?? "infrastructure";
    const target =
      cat === "llm"
        ? groups.llm
        : cat === "web_search"
          ? groups.web_search
          : cat === "infrastructure"
            ? groups.infrastructure
        : groups.infrastructure;
    target.push(b);
  }
  return groups;
}

export default function CircuitBreakers() {
  const { data, isLoading } = useCircuitBreakers();
  const breakers = data?.breakers ?? [];
  const grouped = groupByCategory(breakers);
  const categoryOrder = ["llm", "web_search", "infrastructure"] as const;

  const anyOpen = breakers.some((b) => b.state === "open");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Circuit Breakers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-service circuit breaker states, trip counts, and remediation guidance
        </p>
      </div>

      {anyOpen && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">
            One or more circuit breakers are open. Check the remediation hints below.
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : breakers.length === 0 ? (
        <EmptyState title="No circuit breaker data" />
      ) : (
        <div className="space-y-6">
          {categoryOrder.map((cat) => {
            const items = grouped[cat] ?? [];
            if (!items.length) return null;
            return (
              <div key={cat}>
                <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
                  {CATEGORY_LABELS[cat]}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((b) => (
                    <BreakerCard key={b.name} breaker={b} />
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

function BreakerCard({ breaker: b }: { breaker: CircuitBreakerState }) {
  const isHealthy = b.state === "closed";

  return (
    <div
      className={`rounded-lg border p-4 ${
        b.state === "open"
          ? "border-red-200 bg-red-50"
          : b.state === "half_open"
            ? "border-amber-200 bg-amber-50"
            : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-900">{b.name}</span>
        <StatusBadge status={b.state} />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        <span>Trips: <strong className="text-gray-700">{b.trips}</strong></span>
        {b.last_trip && <span>Last: {b.last_trip}</span>}
        {b.retry_total != null && b.retry_total > 0 && (
          <span>Retries: <strong className="text-gray-700">{b.retry_total}</strong></span>
        )}
        {b.fallback_total != null && b.fallback_total > 0 && (
          <span>Fallbacks: <strong className="text-gray-700">{b.fallback_total}</strong></span>
        )}
      </div>

      {!isHealthy && b.remediation && (
        <p className="mt-2 rounded bg-white/60 p-2 text-xs text-gray-600 leading-relaxed">
          {b.remediation}
        </p>
      )}
    </div>
  );
}
