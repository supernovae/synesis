import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import client from "../../api/client";
import MetricCard from "../../components/common/MetricCard";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { Plus, Play, X, ChevronRight, BarChart3, FlaskConical } from "lucide-react";

interface RunSummary {
  run_id: string;
  name: string;
  description: string;
  status: string;
  run_type: string;
  created_by: string;
  baseline_model: string;
  candidate_model: string;
  prompt_category: string;
  total_prompts: number;
  completed_prompts: number;
  failed_prompts: number;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface LabsStats {
  total_runs: number;
  pending: number;
  running: number;
  completed: number;
  needs_review: number;
}

function useLabsStats() {
  return useQuery<LabsStats>({
    queryKey: ["testing-labs", "stats"],
    queryFn: () => client.get("/testing-labs/stats").then((r) => r.data),
    refetchInterval: 15000,
  });
}

function useLabsRuns(status: string) {
  return useQuery<{ runs: RunSummary[]; total: number }>({
    queryKey: ["testing-labs", "runs", status],
    queryFn: () =>
      client.get("/testing-labs/runs", { params: { status, limit: 100 } }).then((r) => r.data),
    refetchInterval: 10000,
  });
}

function CreateRunModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runType, setRunType] = useState("replay");
  const [baselineModel, setBaselineModel] = useState("");
  const [candidateModel, setCandidateModel] = useState("");
  const [promptCategory, setPromptCategory] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      client
        .post("/testing-labs/runs", {
          name,
          description,
          run_type: runType,
          baseline_model: baselineModel,
          candidate_model: candidateModel,
          prompt_category: promptCategory,
        })
        .then((r) => r.data),
    onSuccess: () => {
      onCreated();
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">New Testing Run</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="Model swap regression check"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              rows={2}
              placeholder="Compare quality before/after model change"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Run Type</label>
              <select
                value={runType}
                onChange={(e) => setRunType(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="replay">Trace Replay</option>
                <option value="prompt_suite">Prompt Suite</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Category</label>
              <input
                value={promptCategory}
                onChange={(e) => setPromptCategory(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                placeholder="retrieval_quality"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Baseline Model</label>
              <input
                value={baselineModel}
                onChange={(e) => setBaselineModel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                placeholder="synesis-general"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Candidate Model</label>
              <input
                value={candidateModel}
                onChange={(e) => setCandidateModel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                placeholder="synesis-general-v2"
              />
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {mutation.isPending ? "Creating..." : "Create Run"}
          </button>
        </div>
        {mutation.isError && (
          <p className="mt-2 text-sm text-red-500">Failed to create run. Please try again.</p>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, onStart }: { run: RunSummary; onStart: (id: string) => void }) {
  const progress =
    run.total_prompts > 0 ? Math.round((run.completed_prompts / run.total_prompts) * 100) : 0;

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
      <td className="px-4 py-3 text-sm">
        <div className="font-medium text-gray-900 dark:text-white">{run.name}</div>
        <div className="text-xs text-gray-500">{run.run_id}</div>
      </td>
      <td className="px-4 py-3 text-sm">
        <StatusBadge status={run.status} />
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
        {run.run_type}
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
        <div>{run.baseline_model || "—"}</div>
        <div className="text-xs text-gray-400">vs {run.candidate_model || "—"}</div>
      </td>
      <td className="px-4 py-3 text-sm text-right text-gray-700 dark:text-gray-300">
        {run.total_prompts > 0 ? (
          <span>
            {run.completed_prompts}/{run.total_prompts}{" "}
            <span className="text-xs text-gray-400">({progress}%)</span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {run.created_at ? new Date(run.created_at).toLocaleDateString() : "—"}
      </td>
      <td className="px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          {run.status === "pending" && (
            <button
              onClick={() => onStart(run.run_id)}
              className="rounded p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
              title="Start run"
            >
              <Play className="h-4 w-4" />
            </button>
          )}
          {run.status === "completed" && (
            <button className="rounded p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20" title="View comparison">
              <BarChart3 className="h-4 w-4" />
            </button>
          )}
          <ChevronRight className="h-4 w-4 text-gray-400" />
        </div>
      </td>
    </tr>
  );
}

export default function TestingLabs() {
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const qc = useQueryClient();
  const { data: stats, isLoading: statsLoading } = useLabsStats();
  const { data: runsData, isLoading: runsLoading } = useLabsRuns(statusFilter);

  const startMutation = useMutation({
    mutationFn: (runId: string) => client.post(`/testing-labs/runs/${runId}/start`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["testing-labs"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-900 dark:text-white">
            <FlaskConical className="h-6 w-6 text-indigo-500" />
            Testing Labs
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Replay runs, model comparisons, and quality regression validation
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          New Run
        </button>
      </div>

      {statsLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : stats ? (
        <div className="grid gap-4 sm:grid-cols-5">
          <MetricCard label="Total Runs" value={stats.total_runs} />
          <MetricCard label="Pending" value={stats.pending} />
          <MetricCard label="Running" value={stats.running} />
          <MetricCard label="Completed" value={stats.completed} />
          <MetricCard label="Needs Review" value={stats.needs_review} />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-500">Filter:</span>
        {["", "pending", "running", "completed", "failed"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === s
                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {runsLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : !runsData?.runs?.length ? (
        <EmptyState
          title="No testing runs"
          description="Create a new run to compare model quality, validate corpus changes, or replay traces"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Run</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Models</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Progress</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Created</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {runsData.runs.map((run) => (
                <RunRow
                  key={run.run_id}
                  run={run}
                  onStart={(id) => startMutation.mutate(id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateRunModal
          onClose={() => setShowCreate(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ["testing-labs"] })}
        />
      )}
    </div>
  );
}
