import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, XCircle, Copy, Plus, Trash2, Pencil } from "lucide-react";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface Clause {
  id: number;
  clause_id: string;
  constitution_id: string;
  category: string;
  constraint_kind: string;
  statement: string;
  machine_rule: Record<string, unknown> | null;
  applicability: Record<string, unknown> | null;
  evidence_requirements: Record<string, unknown> | null;
  actions: Record<string, unknown> | null;
  enabled: boolean;
  priority: number;
}

interface ConstitutionFull {
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
  provenance_checksum: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
  clauses: Clause[];
}

const CATEGORIES = ["safety", "compliance", "quality", "style", "architecture", "tooling", "process"];
const CONSTRAINT_KINDS = ["hard", "guiding", "advisory"];

const KIND_COLORS: Record<string, string> = {
  hard: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  guiding: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  advisory: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export default function ConstitutionDetail() {
  const { constitutionId } = useParams<{ constitutionId: string }>();
  const queryClient = useQueryClient();
  const [showAddClause, setShowAddClause] = useState(false);
  const [editingClause, setEditingClause] = useState<string | null>(null);
  const [clauseForm, setClauseForm] = useState({ category: "quality", constraint_kind: "guiding", statement: "", priority: 0, enabled: true });

  const { data, isLoading, error } = useQuery<ConstitutionFull>({
    queryKey: ["governance-constitution", constitutionId],
    queryFn: () => client.get(`/governance/constitutions/${constitutionId}`).then((r) => r.data),
    enabled: !!constitutionId,
  });

  const activate = useMutation({
    mutationFn: () => client.post(`/governance/constitutions/${constitutionId}/activate`).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["governance-constitution", constitutionId] }),
  });

  const deprecate = useMutation({
    mutationFn: () => client.post(`/governance/constitutions/${constitutionId}/deprecate`).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["governance-constitution", constitutionId] }),
  });

  const clone = useMutation({
    mutationFn: () => client.post(`/governance/constitutions/${constitutionId}/clone`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["governance-constitution", constitutionId] });
      queryClient.invalidateQueries({ queryKey: ["governance-constitutions"] });
    },
  });

  const addClause = useMutation({
    mutationFn: (body: typeof clauseForm) => client.post(`/governance/constitutions/${constitutionId}/clauses`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["governance-constitution", constitutionId] });
      setShowAddClause(false);
      setClauseForm({ category: "quality", constraint_kind: "guiding", statement: "", priority: 0, enabled: true });
    },
  });

  const updateClause = useMutation({
    mutationFn: ({ clauseId, body }: { clauseId: string; body: Record<string, unknown> }) =>
      client.put(`/governance/clauses/${clauseId}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["governance-constitution", constitutionId] });
      setEditingClause(null);
    },
  });

  const deleteClause = useMutation({
    mutationFn: (clauseId: string) => client.delete(`/governance/clauses/${clauseId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["governance-constitution", constitutionId] }),
  });

  if (isLoading) return <div className="p-8 text-center text-sm text-gray-400">Loading...</div>;
  if (error) return <ApiErrorBanner error={error} />;
  if (!data) return <div className="p-8 text-center text-sm text-gray-400">Not found</div>;

  const isDraft = data.status === "draft";
  const isActive = data.status === "active";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{data.name}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {data.scope}{data.scope_value ? ` / ${data.scope_value}` : ""} · v{data.version} · {data.maturity_mode}
          </p>
          {data.description && <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{data.description}</p>}
        </div>
        <div className="flex gap-2">
          {isDraft && (
            <button onClick={() => activate.mutate()} disabled={activate.isPending} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
              <CheckCircle className="h-4 w-4" /> Activate
            </button>
          )}
          {isActive && (
            <button onClick={() => deprecate.mutate()} disabled={deprecate.isPending} className="flex items-center gap-1.5 rounded-lg bg-yellow-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-yellow-700 disabled:opacity-50">
              <XCircle className="h-4 w-4" /> Deprecate
            </button>
          )}
          <button onClick={() => clone.mutate()} disabled={clone.isPending} className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 disabled:opacity-50">
            <Copy className="h-4 w-4" /> Clone as Draft
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <InfoField label="Status" value={data.status} />
        <InfoField label="Precedence" value={String(data.precedence)} />
        <InfoField label="Checksum" value={data.provenance_checksum || "—"} />
        <InfoField label="Created by" value={data.created_by || "—"} />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Clauses ({data.clauses.length})</h2>
          {isDraft && (
            <button onClick={() => setShowAddClause(!showAddClause)} className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700">
              <Plus className="h-3.5 w-3.5" /> Add Clause
            </button>
          )}
        </div>

        {showAddClause && (
          <div className="border-b border-blue-100 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={clauseForm.category} onChange={(e) => setClauseForm({ ...clauseForm, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={clauseForm.constraint_kind} onChange={(e) => setClauseForm({ ...clauseForm, constraint_kind: e.target.value })}>
                {CONSTRAINT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input className="rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" type="number" placeholder="Priority" value={clauseForm.priority} onChange={(e) => setClauseForm({ ...clauseForm, priority: Number(e.target.value) })} />
              <div />
              <textarea className="col-span-full rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" rows={2} placeholder="Clause statement..." value={clauseForm.statement} onChange={(e) => setClauseForm({ ...clauseForm, statement: e.target.value })} />
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => addClause.mutate(clauseForm)} disabled={!clauseForm.statement || addClause.isPending} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {addClause.isPending ? "Adding..." : "Add Clause"}
              </button>
              <button onClick={() => setShowAddClause(false)} className="rounded border px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400">Cancel</button>
            </div>
          </div>
        )}

        {data.clauses.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No clauses defined</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.clauses.map((cl) => (
              <div key={cl.clause_id} className="px-4 py-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_COLORS[cl.constraint_kind] ?? ""}`}>{cl.constraint_kind}</span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">{cl.category}</span>
                      <span className="text-xs text-gray-400">priority: {cl.priority}</span>
                      {!cl.enabled && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">disabled</span>}
                    </div>
                    {editingClause === cl.clause_id ? (
                      <EditClauseInline
                        clause={cl}
                        onSave={(body) => updateClause.mutate({ clauseId: cl.clause_id, body })}
                        onCancel={() => setEditingClause(null)}
                        isPending={updateClause.isPending}
                      />
                    ) : (
                      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{cl.statement}</p>
                    )}
                  </div>
                  {isDraft && editingClause !== cl.clause_id && (
                    <div className="ml-3 flex gap-1">
                      <button onClick={() => setEditingClause(cl.clause_id)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => deleteClause.mutate(cl.clause_id)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-sm font-medium text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}

function EditClauseInline({ clause, onSave, onCancel, isPending }: {
  clause: Clause;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [stmt, setStmt] = useState(clause.statement);
  const [cat, setCat] = useState(clause.category);
  const [kind, setKind] = useState(clause.constraint_kind);
  const [prio, setPrio] = useState(clause.priority);
  return (
    <div className="mt-2 space-y-2">
      <textarea className="w-full rounded border px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" rows={2} value={stmt} onChange={(e) => setStmt(e.target.value)} />
      <div className="flex gap-2">
        <select className="rounded border px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={cat} onChange={(e) => setCat(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="rounded border px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white" value={kind} onChange={(e) => setKind(e.target.value)}>
          {CONSTRAINT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className="w-16 rounded border px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white" type="number" value={prio} onChange={(e) => setPrio(Number(e.target.value))} />
        <button onClick={() => onSave({ statement: stmt, category: cat, constraint_kind: kind, priority: prio })} disabled={isPending} className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
        <button onClick={onCancel} className="rounded border px-3 py-1 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">Cancel</button>
      </div>
    </div>
  );
}
