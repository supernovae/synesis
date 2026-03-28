import { useState, useMemo } from "react";
import { clsx } from "clsx";
import {
  Plus,
  Trash2,
  RefreshCw,
  Search,
  ArrowRight,
  Database,
  X,
} from "lucide-react";
import {
  useAuthzTuples,
  useWriteAuthzTuple,
  useDeleteAuthzTuple,
} from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

function TupleForm({
  onSubmit,
  isPending,
  submitLabel,
  submitIcon: Icon,
  variant = "primary",
}: {
  onSubmit: (t: { user: string; relation: string; object: string }) => void;
  isPending: boolean;
  submitLabel: string;
  submitIcon: React.ElementType;
  variant?: "primary" | "danger";
}) {
  const [user, setUser] = useState("");
  const [relation, setRelation] = useState("");
  const [object, setObject] = useState("");

  function handle(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !relation || !object) return;
    onSubmit({ user, relation, object });
    setUser("");
    setRelation("");
    setObject("");
  }

  return (
    <form onSubmit={handle} className="flex items-end gap-3">
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-500">User</label>
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="user:alice or org:acme#member"
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-500">
          Relation
        </label>
        <input
          value={relation}
          onChange={(e) => setRelation(e.target.value)}
          placeholder="can_invoke, member, admin..."
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-500">
          Object
        </label>
        <input
          value={object}
          onChange={(e) => setObject(e.target.value)}
          placeholder="planner_endpoint:chat_completions"
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <button
        type="submit"
        disabled={isPending || !user || !relation || !object}
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50",
          variant === "primary"
            ? "bg-gray-900 text-white hover:bg-gray-800"
            : "bg-red-600 text-white hover:bg-red-700",
        )}
      >
        <Icon className="h-4 w-4" />
        {submitLabel}
      </button>
    </form>
  );
}

export default function AuthzTuples() {
  const [filterUser, setFilterUser] = useState("");
  const [filterRelation, setFilterRelation] = useState("");
  const [filterObject, setFilterObject] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<{
    user?: string;
    relation?: string;
    object?: string;
  }>({});
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    user: string;
    relation: string;
    object: string;
  } | null>(null);
  const [successMsg, setSuccessMsg] = useState("");

  const { data, isLoading, refetch } = useAuthzTuples(appliedFilters);
  const writeMut = useWriteAuthzTuple();
  const deleteMut = useDeleteAuthzTuple();

  function applyFilters() {
    const f: Record<string, string> = {};
    if (filterUser.trim()) f.user = filterUser.trim();
    if (filterRelation.trim()) f.relation = filterRelation.trim();
    if (filterObject.trim()) f.object = filterObject.trim();
    setAppliedFilters(f);
  }

  function clearFilters() {
    setFilterUser("");
    setFilterRelation("");
    setFilterObject("");
    setAppliedFilters({});
  }

  const hasFilters =
    appliedFilters.user || appliedFilters.relation || appliedFilters.object;

  const tuplesByType = useMemo(() => {
    if (!data?.tuples) return {};
    const grouped: Record<string, typeof data.tuples> = {};
    for (const t of data.tuples) {
      const objType = t.object.split(":")[0] || "unknown";
      (grouped[objType] ??= []).push(t);
    }
    return grouped;
  }, [data]);

  function flash(msg: string) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 3000);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Authorization Tuples
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Browse, add, and remove OpenFGA relationship tuples
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              showAdd
                ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                : "bg-gray-900 text-white hover:bg-gray-800",
            )}
          >
            {showAdd ? (
              <X className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {showAdd ? "Cancel" : "Write tuple"}
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          {successMsg}
        </div>
      )}

      {/* Write form */}
      {showAdd && (
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium text-gray-900">
            Write a new tuple
          </h3>
          <TupleForm
            submitLabel="Write"
            submitIcon={Plus}
            isPending={writeMut.isPending}
            onSubmit={(t) =>
              writeMut.mutate(t, {
                onSuccess: () => {
                  flash("Tuple written successfully");
                  refetch();
                  setShowAdd(false);
                },
              })
            }
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500">
              Filter user
            </label>
            <input
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              placeholder="user:alice"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500">
              Filter relation
            </label>
            <input
              value={filterRelation}
              onChange={(e) => setFilterRelation(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              placeholder="can_invoke"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500">
              Filter object
            </label>
            <input
              value={filterObject}
              onChange={(e) => setFilterObject(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              placeholder="planner_endpoint:chat_completions"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
          </div>
          <button
            onClick={applyFilters}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            <Search className="h-4 w-4" />
            Search
          </button>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="mb-3 text-sm text-red-800">
            Delete tuple:{" "}
            <span className="font-mono font-medium">{deleteTarget.user}</span>{" "}
            #{deleteTarget.relation}{" "}
            <span className="font-mono font-medium">{deleteTarget.object}</span>
            ?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                deleteMut.mutate(deleteTarget, {
                  onSuccess: () => {
                    flash("Tuple deleted");
                    setDeleteTarget(null);
                    refetch();
                  },
                });
              }}
              disabled={deleteMut.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Confirm delete
            </button>
            <button
              onClick={() => setDeleteTarget(null)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-lg border border-gray-200 bg-gray-50"
            />
          ))}
        </div>
      ) : !data || data.count === 0 ? (
        <EmptyState
          icon={Database}
          title="No tuples found"
          description={
            hasFilters
              ? "Try adjusting your filters"
              : "No relationship tuples exist yet"
          }
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            {data.count} tuple{data.count !== 1 ? "s" : ""} found
          </p>
          {Object.entries(tuplesByType)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([objType, tuples]) => (
              <div
                key={objType}
                className="overflow-hidden rounded-lg border border-gray-200"
              >
                <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                    {objType}{" "}
                    <span className="text-gray-400">({tuples.length})</span>
                  </h3>
                </div>
                <table className="min-w-full divide-y divide-gray-200">
                  <thead>
                    <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-2">User / Subject</th>
                      <th className="px-4 py-2">Relation</th>
                      <th className="px-4 py-2">Object</th>
                      <th className="px-4 py-2">Written</th>
                      <th className="px-4 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {tuples.map((t, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-sm">
                          <span className="font-mono text-gray-700">
                            {t.user}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-sm">
                          <span className="inline-flex items-center gap-1 text-gray-600">
                            <ArrowRight className="h-3 w-3" />
                            {t.relation}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-sm">
                          <span className="font-mono text-gray-700">
                            {t.object}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400">
                          {t.timestamp
                            ? new Date(t.timestamp).toLocaleString()
                            : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() =>
                              setDeleteTarget({
                                user: t.user,
                                relation: t.relation,
                                object: t.object,
                              })
                            }
                            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                            title="Delete tuple"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
