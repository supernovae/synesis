import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck, Plus, Trash2 } from "lucide-react";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface AclPolicy {
  id: number;
  name: string;
  description: string;
  org_id: string;
  scope: string;
  target_type: string;
  acl_groups: string[];
  route_groups: string[];
  effect: string;
  priority: number;
  created_by: string;
}

const SCOPE_OPTIONS = ["platform", "org", "tenant"];
const TARGET_OPTIONS = ["content", "route", "both"];
const EFFECT_OPTIONS = ["allow", "deny"];

export default function AclPolicies() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    org_id: "",
    scope: "org",
    target_type: "content",
    acl_groups: "",
    route_groups: "",
    effect: "allow",
    priority: 0,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["acl-policies"],
    queryFn: () => client.get("/acl/policies").then((r) => r.data),
  });

  const createPolicy = useMutation({
    mutationFn: (body: Record<string, unknown>) => client.post("/acl/policies", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acl-policies"] });
      setShowCreate(false);
      setForm({ name: "", description: "", org_id: "", scope: "org", target_type: "content", acl_groups: "", route_groups: "", effect: "allow", priority: 0 });
    },
  });

  const deletePolicy = useMutation({
    mutationFn: (id: number) => client.delete(`/acl/policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["acl-policies"] }),
  });

  const policies: AclPolicy[] = data?.policies ?? [];

  const handleSubmit = () => {
    createPolicy.mutate({
      ...form,
      acl_groups: form.acl_groups ? form.acl_groups.split(",").map((s) => s.trim()).filter(Boolean) : null,
      route_groups: form.route_groups ? form.route_groups.split(",").map((s) => s.trim()).filter(Boolean) : null,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">ACL Policies</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Define authorization policies linking ACL groups to content and route access
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> New Policy
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 font-medium text-gray-900 dark:text-white">Create Policy</h3>
          <div className="grid grid-cols-2 gap-4">
            <input
              placeholder="Policy name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="Organization ID"
              value={form.org_id}
              onChange={(e) => setForm({ ...form, org_id: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="col-span-2 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <select
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              {SCOPE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={form.target_type}
              onChange={(e) => setForm({ ...form, target_type: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              {TARGET_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              value={form.effect}
              onChange={(e) => setForm({ ...form, effect: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              {EFFECT_OPTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <input
              type="number"
              placeholder="Priority"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="ACL groups (comma-separated group IDs)"
              value={form.acl_groups}
              onChange={(e) => setForm({ ...form, acl_groups: e.target.value })}
              className="col-span-2 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="Route groups (comma-separated)"
              value={form.route_groups}
              onChange={(e) => setForm({ ...form, route_groups: e.target.value })}
              className="col-span-2 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>
          <ApiErrorBanner error={createPolicy.error} onDismiss={() => createPolicy.reset()} />
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={!form.name || createPolicy.isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {createPolicy.isPending ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && <p className="text-sm text-gray-500">Loading policies...</p>}
      <ApiErrorBanner error={error} />
      <ApiErrorBanner error={deletePolicy.error} onDismiss={() => deletePolicy.reset()} />

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              {["Name", "Scope", "Target", "Effect", "Priority", "Groups", ""].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800">
            {policies.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{p.name}</div>
                  {p.description && <div className="text-xs text-gray-500">{p.description}</div>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{p.scope}</td>
                <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{p.target_type}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${p.effect === "allow" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"}`}>
                    {p.effect}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{p.priority}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{p.acl_groups?.join(", ") || "—"}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => { if (confirm(`Delete policy "${p.name}"?`)) deletePolicy.mutate(p.id); }}
                    className="text-red-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && policies.length === 0 && (
          <div className="p-8 text-center">
            <FileCheck className="mx-auto h-8 w-8 text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No policies defined yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
