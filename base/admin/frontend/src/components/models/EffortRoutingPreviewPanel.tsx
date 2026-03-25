import { useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useEffortRecommendationPreview } from "../../api/hooks";
import { ApiErrorBanner } from "../common/ApiErrorBanner";

type EffortMode = "auto" | "pulse" | "core" | "horizon";

const MODE_OPTIONS: Array<{ value: EffortMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "pulse", label: "Pulse" },
  { value: "core", label: "Core" },
  { value: "horizon", label: "Horizon" },
];

function Meter({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className="w-full">
      <div className="h-2 rounded bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
        <div className="h-full bg-indigo-500" style={{ width: `${Math.round(clamped * 100)}%` }} />
      </div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{clamped.toFixed(2)}</div>
    </div>
  );
}

export function EffortRoutingPreviewPanel({ showTitle = true }: { showTitle?: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [effortMode, setEffortMode] = useState<EffortMode>("auto");
  const [includeFrame, setIncludeFrame] = useState(false);
  const [operationalHealth, setOperationalHealth] = useState("1.0");
  const preview = useEffortRecommendationPreview();

  const result = preview.data;
  const healthNum = useMemo(() => {
    const parsed = Number.parseFloat(operationalHealth);
    if (Number.isNaN(parsed)) return undefined;
    return Math.max(0, Math.min(1, parsed));
  }, [operationalHealth]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        {showTitle ? (
          <>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-500" />
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Effort Routing Preview</h1>
            </div>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Preview planner effort recommendations without running the full graph.
            </p>
          </>
        ) : null}

        <div className={`grid grid-cols-1 gap-4 lg:grid-cols-2 ${showTitle ? "mt-4" : ""}`}>
          <label className="block">
            <div className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Mode</div>
            <select
              value={effortMode}
              onChange={(e) => setEffortMode(e.target.value as EffortMode)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <div className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Operational Health (0-1)</div>
            <input
              value={operationalHealth}
              onChange={(e) => setOperationalHealth(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="1.0"
            />
          </label>
        </div>

        <label className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={includeFrame} onChange={(e) => setIncludeFrame(e.target.checked)} />
          Include semantic frame extraction
        </label>

        <label className="mt-4 block">
          <div className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Prompt</div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            placeholder="Paste a user prompt to preview effort routing..."
          />
        </label>

        <div className="mt-4">
          <button
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!prompt.trim() || preview.isPending}
            onClick={() =>
              preview.mutate({
                prompt: prompt.trim(),
                effort_mode: effortMode,
                include_frame: includeFrame,
                operational_health: healthNum ?? null,
              })
            }
          >
            {preview.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Run Preview
          </button>
        </div>

        <div className="mt-4">
          <ApiErrorBanner error={preview.error} />
        </div>
      </div>

      {result ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 xl:col-span-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recommendation</h2>
            <dl className="mt-2 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Requested</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">{result.requested_mode}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Recommended</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">{result.recommendation.recommended_mode}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Selected</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">{result.selected_mode}</dd>
              </div>
            </dl>
            <div className="mt-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Confidence</div>
              <Meter value={result.recommendation.confidence} />
            </div>
            <div className="mt-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Reasons</div>
              <ul className="list-disc space-y-1 pl-4 text-sm text-zinc-700 dark:text-zinc-300">
                {result.recommendation.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 xl:col-span-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Routing Signals</h2>
            <div className="mt-3 space-y-3">
              {Object.entries(result.recommendation.routing_signals).map(([key, val]) => (
                <div key={key}>
                  <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{key.replaceAll("_", " ")}</div>
                  <Meter value={typeof val === "number" ? val : 0} />
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 xl:col-span-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Execution Policy</h2>
            <pre className="mt-2 overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-100">
              {JSON.stringify(result.policy, null, 2)}
            </pre>
            <h3 className="mt-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Classifier Snapshot</h3>
            <pre className="mt-2 overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-100">
              {JSON.stringify(result.classification, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
