import { Link } from "react-router-dom";

/** Short definitions + link to Models & Costs overview hub. */
export function UsageGlossaryBanner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border border-blue-200 bg-blue-50/80 p-4 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100 ${className}`}
    >
      <p className="font-medium">How we count usage</p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-blue-900/90 dark:text-blue-200/90">
        <li>
          <strong>Estimated</strong> — configured $/M rates × tokens (traces / rollups), not a provider
          invoice.
        </li>
        <li>
          <strong>Actual</strong> — sum of provider-reported per-call costs when present on LLM calls.
        </li>
        <li>
          <strong>Rollups</strong> — 5-minute buckets built from traces; may lag until the rollup job runs.
        </li>
        <li>
          <strong>Yarn / IDE</strong> — separate path (<code className="rounded bg-blue-100 px-1 dark:bg-blue-900">yarn_usage_log</code>
          ), shown alongside pipeline totals on the{" "}
          <Link to="/models/overview" className="font-medium underline">
            Overview
          </Link>
          .
        </li>
        <li>
          <strong>Tokens Saved</strong> — estimated tokens prevented from reaching the model by
          tool-result reduction, JSON compaction, content dispatch, and admission normalization.
        </li>
      </ul>
    </div>
  );
}
