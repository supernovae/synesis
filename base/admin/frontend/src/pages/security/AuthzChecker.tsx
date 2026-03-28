import { useState } from "react";
import { clsx } from "clsx";
import {
  CheckCircle2,
  XCircle,
  Search,
  User,
  ShieldCheck,
  ArrowRight,
  Network,
  Loader2,
} from "lucide-react";
import {
  useRunAuthzCheck,
  useAuthzUserPermissions,
  type AuthzCheckResult,
} from "../../api/hooks";

function CheckForm() {
  const [user, setUser] = useState("user:");
  const [relation, setRelation] = useState("");
  const [object, setObject] = useState("");
  const [history, setHistory] = useState<AuthzCheckResult[]>([]);

  const checkMut = useRunAuthzCheck();

  function handleCheck(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !relation || !object) return;
    checkMut.mutate(
      { user, relation, object },
      { onSuccess: (r) => setHistory((prev) => [r, ...prev].slice(0, 20)) },
    );
  }

  const presets = [
    { label: "Planner invoke", rel: "can_invoke", obj: "planner_endpoint:chat_completions" },
    { label: "Yarn completions", rel: "can_invoke", obj: "yarn_endpoint:completions" },
    { label: "Yarn messages", rel: "can_invoke", obj: "yarn_endpoint:messages" },
    { label: "RAG public read", rel: "can_read_public", obj: "rag_catalog:default" },
    { label: "Platform admin", rel: "admin", obj: "platform:synesis" },
    { label: "Admin read", rel: "can_read", obj: "admin_endpoint:dashboard" },
    { label: "Admin manage", rel: "can_manage", obj: "admin_endpoint:dashboard" },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="mb-4 text-sm font-medium text-gray-900">
          Run authorization check
        </h3>
        <form onSubmit={handleCheck} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500">
                User (subject)
              </label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="user:alice"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500">
                Relation
              </label>
              <input
                value={relation}
                onChange={(e) => setRelation(e.target.value)}
                placeholder="can_invoke"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500">
                Object
              </label>
              <input
                value={object}
                onChange={(e) => setObject(e.target.value)}
                placeholder="planner_endpoint:chat_completions"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>
          </div>

          {/* Presets */}
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                type="button"
                key={p.label}
                onClick={() => {
                  setRelation(p.rel);
                  setObject(p.obj);
                }}
                className={clsx(
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  relation === p.rel && object === p.obj
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={
              checkMut.isPending || !user || !relation || !object
            }
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {checkMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Run check
          </button>
        </form>

        {/* Last result */}
        {checkMut.data && (
          <div
            className={clsx(
              "mt-4 flex items-center gap-3 rounded-lg border px-4 py-3",
              checkMut.data.allowed
                ? "border-green-200 bg-green-50"
                : "border-red-200 bg-red-50",
            )}
          >
            {checkMut.data.allowed ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <XCircle className="h-5 w-5 text-red-600" />
            )}
            <div>
              <p
                className={clsx(
                  "text-sm font-medium",
                  checkMut.data.allowed
                    ? "text-green-800"
                    : "text-red-800",
                )}
              >
                {checkMut.data.allowed ? "Allowed" : "Denied"}
              </p>
              <p className="font-mono text-xs text-gray-500">
                {checkMut.data.user}{" "}
                <ArrowRight className="inline h-3 w-3" />{" "}
                {checkMut.data.relation} {checkMut.data.object}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Check history */}
      {history.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-5 py-3">
            <h3 className="text-sm font-medium text-gray-900">
              Check history (this session)
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {history.map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                {r.allowed ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
                <span className="font-mono text-xs text-gray-600">
                  {r.user}
                </span>
                <ArrowRight className="h-3 w-3 text-gray-400" />
                <span className="text-xs text-gray-500">{r.relation}</span>
                <ArrowRight className="h-3 w-3 text-gray-400" />
                <span className="font-mono text-xs text-gray-600">
                  {r.object}
                </span>
                <span
                  className={clsx(
                    "ml-auto rounded-full px-2 py-0.5 text-xs font-medium",
                    r.allowed
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-700",
                  )}
                >
                  {r.allowed ? "allowed" : "denied"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserPermissionsExplorer() {
  const [userId, setUserId] = useState("");
  const [lookupId, setLookupId] = useState("");

  const { data, isLoading, isError } = useAuthzUserPermissions(lookupId);

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-medium text-gray-900">
          Inspect user permissions
        </h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setLookupId(userId.trim());
          }}
          className="flex gap-3"
        >
          <div className="flex-1">
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Enter user ID (e.g. alice, uuid...)"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
          </div>
          <button
            type="submit"
            disabled={!userId.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            <User className="h-4 w-4" />
            Look up
          </button>
        </form>
      </div>

      {isLoading && lookupId && (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="ml-2 text-sm">Loading permissions...</span>
        </div>
      )}

      {isError && lookupId && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Failed to load permissions. The user may not exist or FGA may be
          unreachable.
        </div>
      )}

      {data && (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h4 className="mb-3 text-sm font-medium text-gray-900">
              Computed access checks
            </h4>
            <p className="mb-3 text-xs text-gray-400">
              FGA user: <code className="text-gray-600">{data.fga_user}</code>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(data.computed_checks).map(([check, allowed]) => (
                <div
                  key={check}
                  className={clsx(
                    "flex items-center gap-2 rounded-lg border px-3 py-2",
                    allowed
                      ? "border-green-200 bg-green-50"
                      : "border-gray-200 bg-gray-50",
                  )}
                >
                  {allowed ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-gray-400" />
                  )}
                  <span className="font-mono text-xs text-gray-700">
                    {check}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <h4 className="text-sm font-medium text-gray-900">
                Direct tuples ({data.direct_tuples.length})
              </h4>
            </div>
            {data.direct_tuples.length === 0 ? (
              <div className="px-5 py-6 text-center text-sm text-gray-400">
                No direct tuples for this user
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {data.direct_tuples.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-5 py-2.5 text-xs"
                  >
                    <Network className="h-3.5 w-3.5 text-gray-400" />
                    <span className="font-mono text-gray-600">{t.user}</span>
                    <ArrowRight className="h-3 w-3 text-gray-300" />
                    <span className="text-gray-500">{t.relation}</span>
                    <ArrowRight className="h-3 w-3 text-gray-300" />
                    <span className="font-mono text-gray-600">{t.object}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AuthzChecker() {
  const [tab, setTab] = useState<"check" | "user">("check");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Authorization Debugger
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Test authorization checks and inspect effective user permissions
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5">
        <button
          onClick={() => setTab("check")}
          className={clsx(
            "flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors",
            tab === "check"
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100",
          )}
        >
          <ShieldCheck className="h-4 w-4" />
          Check
        </button>
        <button
          onClick={() => setTab("user")}
          className={clsx(
            "flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors",
            tab === "user"
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100",
          )}
        >
          <User className="h-4 w-4" />
          User Permissions
        </button>
      </div>

      {tab === "check" ? <CheckForm /> : <UserPermissionsExplorer />}
    </div>
  );
}
