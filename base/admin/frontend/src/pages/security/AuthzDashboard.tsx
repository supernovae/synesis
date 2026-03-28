import { useState } from "react";
import { Link } from "react-router-dom";
import { clsx } from "clsx";
import {
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Database,
  Network,
  Activity,
  Search,
  FileText,
  ChevronRight,
} from "lucide-react";
import { useAuthzStatus, useAuthzSchemaTypes } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";

export default function AuthzDashboard() {
  const { data: status, isLoading } = useAuthzStatus();
  const { data: schema } = useAuthzSchemaTypes();
  const [expandedType, setExpandedType] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Authorization Policy
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            OpenFGA authorization engine status, schema, and evaluation history
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/security/authz-tuples"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Database className="h-4 w-4" />
            Manage Tuples
          </Link>
          <Link
            to="/security/authz-checker"
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            <Search className="h-4 w-4" />
            Check Debugger
          </Link>
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
      ) : !status ? (
        <EmptyState
          icon={ShieldCheck}
          title="Unable to load status"
          description="OpenFGA may not be configured or reachable"
        />
      ) : (
        <>
          {/* Connection status banner */}
          <div
            className={clsx(
              "flex items-center gap-3 rounded-lg border px-4 py-3",
              status.openfga_configured
                ? "border-green-200 bg-green-50"
                : "border-red-200 bg-red-50",
            )}
          >
            {status.openfga_configured ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <XCircle className="h-5 w-5 text-red-600" />
            )}
            <div>
              <p
                className={clsx(
                  "text-sm font-medium",
                  status.openfga_configured
                    ? "text-green-800"
                    : "text-red-800",
                )}
              >
                {status.openfga_configured
                  ? "OpenFGA connected and operational"
                  : "OpenFGA not configured"}
              </p>
              {status.store && (
                <p className="text-xs text-green-600">
                  Store: {status.store.store_id} &middot;{" "}
                  {status.store.api_url}
                </p>
              )}
            </div>
          </div>

          {/* Metrics row */}
          <div className="grid grid-cols-4 gap-4">
            <MetricCard
              label="Engine"
              value={status.engine}
              icon={ShieldCheck}
              subtitle={
                status.openfga_configured ? "Active" : "Not configured"
              }
            />
            <MetricCard
              label="Total evaluations"
              value={status.evaluations}
              icon={Activity}
            />
            <MetricCard
              label="Rejections"
              value={status.rejections}
              icon={XCircle}
              trend={status.rejections > 0 ? "up" : "neutral"}
              trendValue={
                status.evaluations > 0
                  ? `${((status.rejections / status.evaluations) * 100).toFixed(1)}% denial rate`
                  : "No evaluations yet"
              }
            />
            <MetricCard
              label="Model types"
              value={status.latest_model?.type_definitions_count ?? 0}
              icon={FileText}
              subtitle={
                status.latest_model
                  ? `Model: ${status.latest_model.id.slice(0, 12)}...`
                  : "No model loaded"
              }
            />
          </div>

          {/* Two-column: recent events + schema */}
          <div className="grid grid-cols-2 gap-6">
            {/* Recent evaluations */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-5 py-3">
                <h3 className="text-sm font-medium text-gray-900">
                  Recent evaluations
                </h3>
              </div>
              {status.recent_events.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-400">
                  No evaluations recorded yet
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {status.recent_events
                    .slice()
                    .reverse()
                    .map((evt, i) => (
                      <div key={i} className="flex items-center gap-3 px-5 py-3">
                        {evt.allow ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-gray-700">
                            <span className="font-medium">
                              {evt.user_id || "unknown"}
                            </span>{" "}
                            &rarr; {evt.resource}:{evt.action}
                          </p>
                          <p className="text-xs text-gray-400">
                            {evt.matched_rules.join(", ")} &middot;{" "}
                            {new Date(evt.timestamp * 1000).toLocaleTimeString()}
                          </p>
                        </div>
                        <span
                          className={clsx(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            evt.allow
                              ? "bg-green-50 text-green-700"
                              : "bg-red-50 text-red-700",
                          )}
                        >
                          {evt.allow ? "allowed" : "denied"}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Schema types */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-5 py-3">
                <h3 className="text-sm font-medium text-gray-900">
                  Authorization model types
                </h3>
                {schema?.model_id && (
                  <p className="text-xs text-gray-400">
                    Model: {schema.model_id}
                  </p>
                )}
              </div>
              {!schema || schema.types.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-400">
                  No schema loaded
                </div>
              ) : (
                <div className="max-h-[420px] divide-y divide-gray-100 overflow-y-auto">
                  {schema.types.map((td) => (
                    <div key={td.type}>
                      <button
                        className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-sm hover:bg-gray-50"
                        onClick={() =>
                          setExpandedType(
                            expandedType === td.type ? null : td.type,
                          )
                        }
                      >
                        <ChevronRight
                          className={clsx(
                            "h-3.5 w-3.5 text-gray-400 transition-transform",
                            expandedType === td.type && "rotate-90",
                          )}
                        />
                        <Network className="h-4 w-4 text-gray-400" />
                        <span className="font-medium text-gray-700">
                          {td.type}
                        </span>
                        <span className="ml-auto text-xs text-gray-400">
                          {Object.keys(td.relations).length} relations
                        </span>
                      </button>
                      {expandedType === td.type && (
                        <div className="bg-gray-50 px-5 py-2">
                          {Object.entries(td.relations).map(([rel, info]) => (
                            <div
                              key={rel}
                              className="flex items-start gap-2 py-1 text-xs"
                            >
                              <span className="mt-0.5 rounded bg-gray-200 px-1.5 py-0.5 font-mono text-gray-600">
                                {rel}
                              </span>
                              {info.directly_related.length > 0 && (
                                <span className="text-gray-400">
                                  &larr;{" "}
                                  {info.directly_related.join(", ")}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
