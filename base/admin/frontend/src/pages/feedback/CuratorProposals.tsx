import { useCuratorProposals, useCuratorAction } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { useAuth } from "../../components/auth/AuthProvider";

export default function CuratorProposals() {
  const { data, isLoading } = useCuratorProposals();
  const action = useCuratorAction();
  const { isAdmin } = useAuth();
  const proposals = data?.proposals ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Curator Proposals</h1>
        <p className="mt-1 text-sm text-gray-500">
          Auto-discovered sources for weak domains -- review and approve
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : proposals.length === 0 ? (
        <EmptyState title="No proposals" description="Run the curator agent to discover new sources" />
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <div key={p.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-medium text-gray-900">{p.source_name}</h3>
                  <p className="mt-0.5 text-xs text-gray-500">{p.domain} -- {p.path}</p>
                  <p className="mt-1 text-sm text-gray-600">{p.rationale}</p>
                  <p className="mt-1 text-xs text-gray-400 font-mono">{p.url}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Score: {p.quality_score}/5</span>
                  <StatusBadge status={p.status} />
                </div>
              </div>
              {isAdmin && p.status === "pending" && (
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => action.mutate({ id: p.id, action: "approve" })}
                    disabled={action.isPending}
                    className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => action.mutate({ id: p.id, action: "reject" })}
                    disabled={action.isPending}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
