import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { clsx } from "clsx";
import { useYarnSessionDetail, type YarnSessionRequestRow, type YarnSessionEventRow } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { fmtCost, fmtDurationMs, fmtTokens, isFallbackPricing, pricingSourceLabel } from "../../lib/formatUsage";
import {
  diagnosticPresetCount,
  eventKindCount,
  eventKinds as listEventKinds,
  filterEventsByDiagnosticPreset,
  filterEventsByKinds,
  isRecord,
  trajectoryHighlights,
  type EventDiagnosticPreset,
} from "./eventDrilldown";

function truncId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function finishReasonIsError(reason: string | null | undefined): boolean {
  const r = (reason || "").toLowerCase();
  return r === "error" || r === "tool_loop_limit_exceeded";
}

export default function YarnSessionDetail() {
  const { sessionKey } = useParams<{ sessionKey: string }>();
  const navigate = useNavigate();
  const key = sessionKey ? decodeURIComponent(sessionKey) : "";
  const { data, isLoading, isError, error } = useYarnSessionDetail(key || undefined);
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<EventDiagnosticPreset | null>(null);
  const [expandedMetadata, setExpandedMetadata] = useState<Record<number, boolean>>({});

  const availableEventKinds = useMemo(() => {
    const src = data?.events ?? [];
    return listEventKinds(src);
  }, [data?.events]);

  const filteredEvents = useMemo(() => {
    const src = data?.events ?? [];
    return filterEventsByDiagnosticPreset(filterEventsByKinds(src, selectedKinds), selectedPreset);
  }, [data?.events, selectedKinds, selectedPreset]);

  const toggleKind = (kind: string) => {
    setSelectedKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
  };

  const toggleMetadata = (eventId: number) => {
    setExpandedMetadata((prev) => ({ ...prev, [eventId]: !prev[eventId] }));
  };

  if (!key) {
    return (
      <EmptyState title="Missing session" description="No session key in the URL." />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate("/yarn/sessions")}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <ArrowLeft className="h-4 w-4" />
          Coder sessions
        </button>
      </div>

      <ApiErrorBanner error={isError ? error : undefined} />

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : isError || !data ? (
        <EmptyState
          title="Session not found"
          description="The session may have been purged or the key is invalid."
        />
      ) : (
        <>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              Coder session
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-gray-500 dark:text-gray-400">
              {data.session.session_key}
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  User
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {data.session.username || data.session.user_id || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Role
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {data.session.role || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Client
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {data.session.client_kind || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Conversation
                </dt>
                <dd className="mt-1 break-all font-mono text-xs text-gray-900 dark:text-gray-100">
                  {data.session.conversation_id || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Provider / Model
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {(data.session.provider || "—") + " · " + (data.session.model || "—")}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Requests
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {data.session.request_count.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Tokens (in / out / cached)
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fmtTokens(data.session.total_tokens_in)} /{" "}
                  {fmtTokens(data.session.total_tokens_out)} /{" "}
                  {fmtTokens(data.session.total_tokens_cached)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Tokens saved (reduction)
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-green-600 dark:text-green-400">
                  {fmtTokens(data.session.total_tokens_saved ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" title="Effective Cost (Actual if available, else Estimated)">
                  Total cost
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100" title={`Actual: ${fmtCost(data.session.total_actual_cost_usd)} | Est: ${fmtCost(data.session.total_estimated_cost_usd)}`}>
                  {fmtCost(data.session.total_actual_cost_usd > 0 ? data.session.total_actual_cost_usd : data.session.total_estimated_cost_usd)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Escalations
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {data.session.escalation_count.toLocaleString()}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h2 className="mb-3 text-lg font-medium text-gray-900 dark:text-white">
              Requests
            </h2>
            {data.requests.length === 0 ? (
              <EmptyState title="No requests logged" description="Usage rows for this session are empty." />
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Request ID
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          In
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Out
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Cached
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Saved
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Latency
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" title="Effective Cost (Actual if available, else Estimated)">
                          Cost
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Flags
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Finish
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Time
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                      {data.requests.map((rq: YarnSessionRequestRow) => (
                        <tr key={rq.id}>
                          <td
                            className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300"
                            title={rq.request_id}
                          >
                            {truncId(rq.request_id)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(rq.tokens_in)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(rq.tokens_out)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(rq.tokens_cached)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-green-600 dark:text-green-400">
                            {rq.tokens_saved_by_reduction ? fmtTokens(rq.tokens_saved_by_reduction) : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtDurationMs(rq.latency_ms)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400" title={`Actual: ${fmtCost(rq.actual_cost_usd)} | Est: ${fmtCost(rq.estimated_cost_usd)}`}>
                            <span>{fmtCost(rq.actual_cost_usd > 0 ? rq.actual_cost_usd : rq.estimated_cost_usd)}</span>
                            {isFallbackPricing(rq.pricing_source) && (
                              <span className="ml-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/30 dark:text-amber-400 dark:ring-amber-500/30" title="Cost derived from fallback base rates — set pricing in Model Registry">
                                {pricingSourceLabel(rq.pricing_source)}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            {rq.escalated ? (
                              <StatusBadge status="warning" label="Escalated" />
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={clsx(
                                finishReasonIsError(rq.finish_reason) && "font-medium text-red-600 dark:text-red-400",
                              )}
                            >
                              {rq.finish_reason || "—"}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600 dark:text-gray-400">
                            {rq.created_at
                              ? new Date(rq.created_at).toLocaleString()
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {data.events && data.events.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-medium text-gray-900 dark:text-white">
                Events
              </h2>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedPreset(null)}
                  className={clsx(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    selectedPreset === null
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  Any diagnostics
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPreset("vercel_sdk_errors")}
                  className={clsx(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    selectedPreset === "vercel_sdk_errors"
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  Vercel SDK errors ({diagnosticPresetCount(data.events, "vercel_sdk_errors")})
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPreset("missing_tool_results")}
                  className={clsx(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    selectedPreset === "missing_tool_results"
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  Missing tool results ({diagnosticPresetCount(data.events, "missing_tool_results")})
                </button>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedKinds([])}
                  className={clsx(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    selectedKinds.length === 0
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  All ({data.events.length})
                </button>
                {availableEventKinds.map((kind) => {
                  const active = selectedKinds.includes(kind);
                  const count = eventKindCount(data.events, kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => toggleKind(kind)}
                      className={clsx(
                        "rounded-full border px-2.5 py-1 text-xs font-medium",
                        active
                          ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                          : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                      )}
                    >
                      {kind} ({count})
                    </button>
                  );
                })}
              </div>
              <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Kind
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Component
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Detail
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Request
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Time
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                      {filteredEvents.map((ev: YarnSessionEventRow) => {
                        const highlights = trajectoryHighlights(ev);
                        const hasMetadata = isRecord(ev.metadata_json);
                        const expanded = expandedMetadata[ev.id] === true;
                        return (
                          <tr key={ev.id}>
                            <td className="whitespace-nowrap px-4 py-3 font-medium text-red-600 dark:text-red-400">
                              {ev.event_kind}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-300">
                              {ev.component || "—"}
                            </td>
                            <td className="max-w-[520px] px-4 py-3 text-gray-600 dark:text-gray-400">
                              <div className="truncate" title={ev.detail}>
                                {ev.detail || "—"}
                              </div>
                              {highlights.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {highlights.map((h) => (
                                    <span
                                      key={`${ev.id}-${h.label}-${h.value}`}
                                      className={clsx(
                                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                                        h.tone === "good" && "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
                                        h.tone === "warn" && "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
                                        (!h.tone || h.tone === "neutral") && "border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300",
                                      )}
                                    >
                                      {h.label}: {h.value}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {hasMetadata && (
                                <div className="mt-2">
                                  <button
                                    type="button"
                                    onClick={() => toggleMetadata(ev.id)}
                                    className="text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                                  >
                                    {expanded ? "Hide metadata JSON" : "Show metadata JSON"}
                                  </button>
                                  {expanded && (
                                    <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-[11px] leading-5 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                                      {JSON.stringify(ev.metadata_json, null, 2)}
                                    </pre>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                              {ev.request_id ? truncId(ev.request_id) : "—"}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600 dark:text-gray-400">
                              {ev.created_at ? new Date(ev.created_at).toLocaleString() : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              {filteredEvents.length === 0 && (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  No events match the selected kind filter.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
