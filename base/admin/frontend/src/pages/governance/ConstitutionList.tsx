import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, FileText } from "lucide-react";
import { Link, useNavigate } from "react-router";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface Constitution {
  id: number;
  constitution_id: string;
  name: string;
  version: number;
  status: string;
  scope: string;
  scope_value: string;
  precedence: number;
  description: string;
  maturity_mode: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  deprecated: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  archived: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export default function ConstitutionList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filterScope, setFilterScope] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", scope: "org", scope_value: "", description: "", maturity_mode: "base", precedence: 0 });

  const { data, isLoading, error } = useQuery<{ constitutions: Constitution[] }>({
    queryKey: ["governance-constitutions", filterScope, filterStatus],
    queryFn: () => client.get("/governance/constitutions", {
      params: { ...(filterScope && { scope: filterScope }), ...(filterStatus && { status: filterStatus }) },
    }).then((r) => r.data),
  });

  const createConstitution = useMutation({
    mutationFn: (body: typeof form) => client.post("/governance/constitutions", body).then((r) => r.data),
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ["governance-constitutions"] });
      setShowCreate(false);
      navigate(`/governance/constitutions/${row.constitution_id}`);
    },
  });

  const constitutions: Constitution[] = data?.constitutions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Constitutions</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Versioned governance bundles scoped to org, tenant, or project</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> Create Constitution
        </button>
      </div>

      {error && <ApiErrorBanner error={error} />}

      {showCreate && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
          <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">New Constitution</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              {["platform", "org", "tenant", "project", "team"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Scope value (org_id, etc.)" value={form.scope_value} onChange={(e) => setForm({ ...form, scope_value: e.target.value })} />
            <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={form.maturity_mode} onChange={(e) => setForm({ ...form, maturity_mode: e.target.value })}>
              {["base", "guided", "governed", "assured"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Precedence" type="number" value={form.precedence} onChange={(e) => setForm({ ...form, precedence: Number(e.target.value) })} />
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => createConstitution.mutate(form)} disabled={!form.name || createConstitution.isPending} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {createConstitution.isPending ? "Creating..." : "Create Draft"}
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded border px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={filterScope} onChange={(e) => setFilterScope(e.target.value)}>
          <option value="">All scopes</option>
          {["platform", "org", "tenant", "project", "team"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["draft", "active", "deprecated", "archived"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading...</div>
        ) : constitutions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <FileText className="h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="text-sm text-gray-500">No constitutions found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase text-gray-500 dark:border-gray-800 dark:text-gray-400">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Version</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Scope</th>
                <th className="px-4 py-2">Maturity</th>
                <th className="px-4 py-2">Precedence</th>
                <th className="px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {constitutions.map((c) => (
                <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-2">
                    <Link to={`/governance/constitutions/${c.constitution_id}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">v{c.version}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[c.status] ?? ""}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{c.scope}{c.scope_value ? ` (${c.scope_value})` : ""}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{c.maturity_mode}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{c.precedence}</td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{c.updated_at ? new Date(c.updated_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
