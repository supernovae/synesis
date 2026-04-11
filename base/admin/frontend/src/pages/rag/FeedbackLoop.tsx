import React, { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import client from "../../api/client";
import MetricCard from "../../components/common/MetricCard";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface SuiteInfo {
  name: string;
  description: string;
  case_count: number;
}

interface OverviewResponse {
  suites: SuiteInfo[];
  recent_runs: Array<{
    run_id: string;
    name: string;
    status: string;
    created_at: string | null;
    total_prompts: number;
    completed_prompts: number;
  }>;
}

export default function FeedbackLoop(): React.ReactElement {
  const [name, setName] = useState("Qwen closed-loop run");
  const [selectedSuites, setSelectedSuites] = useState<string[]>([
    "stability_invalid_tool_args",
    "stability_compile_fix_recovery",
    "stability_resume_continuity",
    "stability_plan_update_loop",
  ]);
  const [runId, setRunId] = useState("");

  const overview = useQuery<OverviewResponse>({
    queryKey: ["feedback-loop", "overview"],
    queryFn: () => client.get("/feedback-loop/overview").then((r) => r.data),
    refetchInterval: 15000,
  });

  const startRun = useMutation({
    mutationFn: () =>
      client
        .post("/feedback-loop/runs", {
          name,
          execute_now: true,
          eval_suites: selectedSuites,
          candidate_model: "synesis-agent",
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      if (data?.run_id) setRunId(String(data.run_id));
      overview.refetch();
    },
  });

  const runPipeline = useMutation({
    mutationFn: () =>
      client
        .post(`/feedback-loop/runs/${runId}/pipeline`, {
          eval_suites: selectedSuites,
          auto_label: true,
        })
        .then((r) => r.data),
  });

  const exportDataset = useMutation({
    mutationFn: () =>
      client
        .get(`/feedback-loop/runs/${runId}/dataset`, {
          params: { format: "jsonl" },
        })
        .then((r) => r.data),
  });

  const suiteSet = useMemo(() => new Set(selectedSuites), [selectedSuites]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Feedback Loop Lab</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          Run closed-loop workflows (replay, regressions, eval suites, auto-labeling, dataset export) from one place.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetricCard label="Eval Suites" value={overview.data?.suites.length ?? 0} />
        <MetricCard label="Recent Runs" value={overview.data?.recent_runs.length ?? 0} />
        <MetricCard label="Selected Suites" value={selectedSuites.length} />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-lg font-medium text-gray-900 dark:text-white">Start End-to-End Run</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            placeholder="Run name"
          />
          <input
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            placeholder="Existing run id (optional)"
          />
        </div>

        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-gray-800 dark:text-gray-200">Eval suites</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {overview.data?.suites.map((suite) => {
              const checked = suiteSet.has(suite.name);
              return (
                <label
                  key={suite.name}
                  className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
                >
                  <span className="pr-2">
                    <span className="font-medium text-gray-900 dark:text-white">{suite.name}</span>
                    <span className="ml-2 text-xs text-gray-500">{suite.case_count} cases</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setSelectedSuites((prev) =>
                        e.target.checked ? [...new Set([...prev, suite.name])] : prev.filter((s) => s !== suite.name),
                      );
                    }}
                  />
                </label>
              );
            })}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => startRun.mutate()}
            disabled={startRun.isPending || !name.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {startRun.isPending ? "Running..." : "Create + Execute Loop"}
          </button>
          <button
            onClick={() => runPipeline.mutate()}
            disabled={runPipeline.isPending || !runId.trim()}
            className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900/20"
          >
            {runPipeline.isPending ? "Running..." : "Run Pipeline for Existing Run"}
          </button>
          <button
            onClick={() => exportDataset.mutate()}
            disabled={exportDataset.isPending || !runId.trim()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {exportDataset.isPending ? "Exporting..." : "Export Dataset"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-medium text-gray-900 dark:text-white">Recent Runs</h2>
        <div className="space-y-2">
          {overview.data?.recent_runs.map((run) => (
            <div
              key={run.run_id}
              className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
            >
              <div>
                <div className="font-medium text-gray-900 dark:text-white">{run.name}</div>
                <div className="text-xs text-gray-500">{run.run_id}</div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-gray-500">{run.status}</div>
                <div className="text-xs text-gray-500">
                  {run.completed_prompts}/{run.total_prompts}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {(startRun.data || runPipeline.data || exportDataset.data) && (
        <pre className="max-h-96 overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200">
          {JSON.stringify(startRun.data ?? runPipeline.data ?? exportDataset.data, null, 2)}
        </pre>
      )}

      <ApiErrorBanner error={overview.error} onDismiss={() => overview.refetch()} />
      <ApiErrorBanner error={startRun.error} onDismiss={() => startRun.reset()} />
      <ApiErrorBanner error={runPipeline.error} onDismiss={() => runPipeline.reset()} />
      <ApiErrorBanner error={exportDataset.error} onDismiss={() => exportDataset.reset()} />
    </div>
  );
}
