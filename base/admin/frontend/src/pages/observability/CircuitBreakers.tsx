import { useCircuitBreakers } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

export default function CircuitBreakers() {
  const { data, isLoading } = useCircuitBreakers();
  const breakers = data?.breakers ?? [];

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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {breakers.map((b) => (
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
      )}
    </div>
  );
}
