import { useState } from "react";
import { Link } from "react-router";
import { clsx } from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Shield,
  ShieldAlert,
  ShieldX,
} from "lucide-react";
import { useSecuritySummary } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-600",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

export default function SecurityDashboard() {
  const [sinceHours, setSinceHours] = useState(24);
  const { data: summary, isLoading } = useSecuritySummary(sinceHours);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Security Console
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Guardrail detections, policy actions, and containment status
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setSinceHours(opt.hours)}
              className={clsx(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                sinceHours === opt.hours
                  ? "bg-gray-900 text-white"
                  : "text-gray-600 hover:bg-gray-100",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-lg border border-gray-200 bg-gray-50"
            />
          ))}
        </div>
      ) : !summary || summary.total === 0 ? (
        <EmptyState
          icon={Shield}
          title="No detections"
          description={`No guardrail events in the last ${sinceHours} hours`}
        />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-4">
            <MetricCard
              label="Total detections"
              value={summary.total}
              icon={ShieldAlert}
            />
            <MetricCard
              label="Unresolved"
              value={summary.unresolved}
              icon={Clock}
              trend={
                summary.unresolved > 0 ? "up" : "neutral"
              }
              trendValue={
                summary.unresolved > 0
                  ? `${summary.unresolved} pending triage`
                  : "All clear"
              }
            />
            <MetricCard
              label="Critical + High"
              value={
                (summary.by_severity?.critical ?? 0) +
                (summary.by_severity?.high ?? 0)
              }
              icon={ShieldX}
            />
            <MetricCard
              label="Resolved"
              value={summary.total - summary.unresolved}
              icon={CheckCircle2}
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-medium text-gray-500">
                By severity
              </h3>
              <div className="mt-3 space-y-2">
                {SEVERITY_ORDER.map((sev) => {
                  const count = summary.by_severity?.[sev] ?? 0;
                  if (count === 0) return null;
                  const pct = Math.round((count / summary.total) * 100);
                  return (
                    <div key={sev} className="flex items-center gap-3">
                      <span className="w-16 text-sm font-medium capitalize text-gray-700">
                        {sev}
                      </span>
                      <div className="flex-1">
                        <div className="h-4 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className={clsx(
                              "h-full rounded-full",
                              SEVERITY_COLORS[sev],
                            )}
                            style={{ width: `${Math.max(pct, 4)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-12 text-right text-sm text-gray-600">
                        {count}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-medium text-gray-500">
                By event type
              </h3>
              <div className="mt-3 space-y-1.5">
                {Object.entries(summary.by_type ?? {})
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => (
                    <div
                      key={type}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate text-gray-700">
                        {type.replace(/_/g, " ")}
                      </span>
                      <span className="ml-3 font-medium text-gray-900">
                        {count}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <Link
              to="/security/events"
              className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              <AlertTriangle className="h-4 w-4" />
              View all events
            </Link>
            <Link
              to="/security/events?resolved=false"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Unresolved events
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
