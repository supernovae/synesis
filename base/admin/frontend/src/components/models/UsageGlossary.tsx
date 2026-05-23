import { Link } from "react-router-dom";

/** Short definitions + link to Models & Pricing overview hub. */
export function UsageGlossaryBanner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border border-blue-200 bg-blue-50/80 p-4 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100 ${className}`}
    >
      <p className="font-medium">How we count usage</p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-blue-900/90 dark:text-blue-200/90">
        <li>
          <strong>Usage Price</strong> — configured $/M rates x tokens; Chat planner-ts pipeline uses{" "}
          <code className="rounded bg-blue-100 px-1 dark:bg-blue-900">planner_usage_log</code> when
          populated (trace rows as admin fallback), not a provider invoice.
        </li>
        <li>
          <strong>Coder / IDE</strong> — separate path (<code className="rounded bg-blue-100 px-1 dark:bg-blue-900">yarn_usage_log</code>
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
