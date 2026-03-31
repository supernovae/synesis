import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil, Scale } from "lucide-react";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface PolicyDef {
  id: number;
  policy_id: string;
  name: string;
  description: string;
  scope: string;
  scope_value: string;
  org_id: string;
  category: string;
  constraint_kind: string;
  rule_type: string;
  rule_config: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

const SCOPES = ["platform", "org", "tenant", "project", "team"];
const CATEGORIES = ["safety", "compliance", "quality", "style", "architecture", "tooling", "process"];
const CONSTRAINT_KINDS = ["hard", "guiding", "advisory"];
const RULE_TYPES = ["threshold", "escalation", "boundary", "routing", "reducer_config", "feature_toggle"];

const KIND_COLORS: Record<string, string> = {
  hard: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  guiding: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  advisory: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export default function PolicyList() {
  const queryClient = useQueryClient();
  const [filterCategory, setFilterCategory] = useState("");
  const [filterRuleType, setFilterRuleType] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", description: "", scope: "org", scope_value: "", org_id: "",
    category: "quality", constraint_kind: "guiding", rule_type: "threshold",
    rule_config_str: "{}", enabled: true, priority: 0,
  });

  const { data, isLoading, error } = useQuery<{ policies: PolicyDef[] }>({
    queryKey: ["governance-policies", filterCategory, filterRuleType],
    queryFn: () => client.get("/governance/policies", {
      params: { ...(filterCategory && { category: filterCategory }), ...(filterRuleType && { rule_type: filterRuleType }) },
    }).then((r) => r.data),
  });

  const createPolicy = useMutation({
    mutationFn: (body: Record<string, unknown>) => client.post("/governance/policies", body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["governance-policies"] });
      setShowCreate(false);
      resetForm();
    },
  });

  const updatePolicy = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => client.put(`/governance/policies/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["governance-policies"] });
      setEditingId(null);
    },
  });

  const deletePolicy = useMutation({
    mutationFn: (id: string) => client.delete(`/governance/policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["governance-policies"] }),
  });

  function resetForm() {
    setForm({ name: "", description: "", scope: "org", scope_value: "", org_id: "", category: "quality", constraint_kind: "guiding", rule_type: "threshold", rule_config_str: "{}", enabled: true, priority: 0 });
  }

  function handleCreate() {
    let rule_config: Record<string, unknown> = {};
    try { rule_config = JSON.parse(form.rule_config_str); } catch { /* leave empty */ }
    createPolicy.mutate({ ...form, rule_config, rule_config_str: undefined });
  }

  const policies: PolicyDef[] = data?.policies ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Standalone Policies</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Individual policy rules not tied to a constitution</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> Create Policy
        </button>
      </div>

      {error && <ApiErrorBanner error={error} />}

      {showCreate && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
          <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">New Policy</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Org ID" value={form.org_id} onChange={(e) => setForm({ ...form, org_id: e.target.value })} />
            <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={form.constraint_kind} onChange={(e) => setForm({ ...form, constraint_kind: e.target.value })}>
              {CONSTRAINT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={form.rule_type} onChange={(e) => setForm({ ...form, rule_type: e.target.value })}>
              {RULE_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" type="number" placeholder="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Rule Config (JSON)</label>
            <textarea className="mt-1 w-full rounded border px-3 py-1.5 font-mono text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white" rows={3} value={form.rule_config_str} onChange={(e) => setForm({ ...form, rule_config_str: e.target.value })} />
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={handleCreate} disabled={!form.name || createPolicy.isPending} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {createPolicy.isPending ? "Creating..." : "Create"}
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded border px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={filterRuleType} onChange={(e) => setFilterRuleType(e.target.value)}>
          <option value="">All rule types</option>
          {RULE_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading...</div>
        ) : policies.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <Scale className="h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="text-sm text-gray-500">No standalone policies found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase text-gray-500 dark:border-gray-800 dark:text-gray-400">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Rule Type</th>
                <th className="px-4 py-2">Scope</th>
                <th className="px-4 py-2">Priority</th>
                <th className="px-4 py-2">Enabled</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.policy_id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{p.name}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{p.category}</td>
                  <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_COLORS[p.constraint_kind] ?? ""}`}>{p.constraint_kind}</span></td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{p.rule_type}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{p.scope}{p.org_id ? ` (${p.org_id})` : ""}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{p.priority}</td>
                  <td className="px-4 py-2">{p.enabled ? <span className="text-green-600">Yes</span> : <span className="text-gray-400">No</span>}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => deletePolicy.mutate(p.policy_id)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
