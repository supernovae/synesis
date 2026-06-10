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

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

type ForensicsSnapshot = {
  eventId: number;
  requestId: string;
  createdAt: string | null;
  tokensIn: number;
  tokensCached: number;
  cacheHitRatio: number;
  lcpRatio: number;
  firstChangedSection: string;
  firstChangedIndex: number | null;
  toolChars: number;
  systemChars: number;
  toolSchemaChars: number;
};

type CapabilityResolutionSummary = {
  createdAt: string | null;
  mode: string;
  globalOptimizationsEnabled: boolean;
  matchedOverrideCount: number;
  reducersEnabled: boolean;
  transcriptPruneEnabled: boolean;
  jsonCompactionEnabled: boolean;
  contentDedupeEnabled: boolean;
};

type CurrentWorkPacketSummary = {
  eventId: number;
  createdAt: string | null;
  hash: string;
  mode: string;
  injected: boolean;
  estimatedTokens: number;
  sourceSections: string[];
  reasons: string[];
  objective: string;
  currentPhase: string;
  nextBestAction: string;
  block: string;
};

function latestCapabilityResolutionFromEvents(
  events: YarnSessionEventRow[],
): CapabilityResolutionSummary | null {
  for (const ev of events) {
    if (ev.event_kind !== "capability_matrix_resolution_v1") continue;
    if (!isRecord(ev.metadata_json)) continue;
    const resolvedCaps = isRecord(ev.metadata_json.resolved_capabilities)
      ? ev.metadata_json.resolved_capabilities
      : null;
    return {
      createdAt: ev.created_at,
      mode: String(ev.metadata_json.mode ?? "enforced"),
      globalOptimizationsEnabled: ev.metadata_json.global_optimizations_enabled === true,
      matchedOverrideCount: Array.isArray(ev.metadata_json.matched_override_ids)
        ? ev.metadata_json.matched_override_ids.length
        : 0,
      reducersEnabled: resolvedCaps?.["yarn.reducers_enabled"] === true,
      transcriptPruneEnabled: resolvedCaps?.["yarn.transcript_prune_enabled"] === true,
      jsonCompactionEnabled: resolvedCaps?.["yarn.json_compaction_enabled"] === true,
      contentDedupeEnabled: resolvedCaps?.["yarn.content_dedupe_enabled"] === true,
    };
  }
  return null;
}

function latestWorkPacketFromEvents(events: YarnSessionEventRow[]): CurrentWorkPacketSummary | null {
  for (const ev of events) {
    if (ev.event_kind !== "current_work_packet_v1") continue;
    if (!isRecord(ev.metadata_json)) continue;
    const summary = isRecord(ev.metadata_json.summary) ? ev.metadata_json.summary : null;
    return {
      eventId: ev.id,
      createdAt: ev.created_at,
      hash: String(ev.metadata_json.hash ?? ""),
      mode: String(ev.metadata_json.mode ?? "adapt"),
      injected: ev.metadata_json.injected === true,
      estimatedTokens: asNumber(ev.metadata_json.estimated_tokens),
      sourceSections: Array.isArray(ev.metadata_json.source_sections)
        ? ev.metadata_json.source_sections.map(String)
        : [],
      reasons: Array.isArray(ev.metadata_json.reasons) ? ev.metadata_json.reasons.map(String) : [],
      objective: String(summary?.objective ?? "—"),
      currentPhase: String(summary?.currentPhase ?? "unknown"),
      nextBestAction: String(summary?.nextBestAction ?? "—"),
      block: String(ev.metadata_json.block ?? ""),
    };
  }
  return null;
}

export default function YarnSessionDetail() {
  const { sessionKey } = useParams<{ sessionKey: string }>();
  const navigate = useNavigate();
  const key = sessionKey ? decodeURIComponent(sessionKey) : "";
  const { data, isLoading, isError, error } = useYarnSessionDetail(key || undefined);
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<EventDiagnosticPreset | null>(null);
  const [expandedMetadata, setExpandedMetadata] = useState<Record<number, boolean>>({});

  const events = useMemo(() => data?.events ?? [], [data]);

  const availableEventKinds = useMemo(() => listEventKinds(events), [events]);

  const filteredEvents = useMemo(() => {
    return filterEventsByDiagnosticPreset(filterEventsByKinds(events, selectedKinds), selectedPreset);
  }, [events, selectedKinds, selectedPreset]);
  const forensicsSnapshots = useMemo<ForensicsSnapshot[]>(() => {
    const rows: ForensicsSnapshot[] = [];
    for (const ev of events) {
      if (ev.event_kind !== "request_forensics_v1") continue;
      if (!isRecord(ev.metadata_json)) continue;
      const usage = isRecord(ev.metadata_json.usage) ? ev.metadata_json.usage : null;
      const breakdown = isRecord(ev.metadata_json.breakdown) ? ev.metadata_json.breakdown : null;
      rows.push({
        eventId: ev.id,
        requestId: ev.request_id ?? "",
        createdAt: ev.created_at,
        tokensIn: asNumber(usage?.tokensIn),
        tokensCached: asNumber(usage?.tokensCached),
        cacheHitRatio: asNumber(usage?.cacheHitRatio),
        lcpRatio: asNumber(ev.metadata_json.lcpRatio),
        firstChangedSection: String(ev.metadata_json.firstChangedSection ?? ""),
        firstChangedIndex: Number.isFinite(asNumber(ev.metadata_json.firstChangedIndex, Number.NaN))
          ? asNumber(ev.metadata_json.firstChangedIndex, Number.NaN)
          : null,
        toolChars: asNumber(breakdown?.toolChars),
        systemChars: asNumber(breakdown?.systemChars),
        toolSchemaChars: asNumber(breakdown?.toolSchemaChars),
      });
    }
    return rows.sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bTime - aTime;
    });
  }, [events]);
  const forensicsSummary = useMemo(() => {
    if (forensicsSnapshots.length === 0) return null;
    const windowRows = forensicsSnapshots.slice(0, 12);
    const latest = windowRows[0];
    if (!latest) return null;
    const avgLcpRatio = windowRows.reduce((sum, row) => sum + row.lcpRatio, 0) / windowRows.length;
    const avgToolChars = windowRows.reduce((sum, row) => sum + row.toolChars, 0) / windowRows.length;
    const minCached = Math.min(...windowRows.map((row) => row.tokensCached));
    const maxCached = Math.max(...windowRows.map((row) => row.tokensCached));
    const minPrompt = Math.min(...windowRows.map((row) => row.tokensIn));
    const maxPrompt = Math.max(...windowRows.map((row) => row.tokensIn));
    const cachedPlateauDetected = (maxCached - minCached) <= 512 && (maxPrompt - minPrompt) >= 20_000;
    return {
      latest,
      avgLcpRatio,
      avgToolChars,
      minCached,
      maxCached,
      minPrompt,
      maxPrompt,
      cachedPlateauDetected,
    };
  }, [forensicsSnapshots]);
  const latestCapabilityResolution = latestCapabilityResolutionFromEvents(events);
  const latestWorkPacket = latestWorkPacketFromEvents(events);
  const sessionPromptTokens = data?.session.total_tokens_in ?? 0;
  const sessionCachedPromptTokens = data?.session.total_tokens_cached ?? 0;
  const sessionEffectivePromptTokens = Math.max(sessionPromptTokens - sessionCachedPromptTokens, 0);
  const sessionPromptCacheHitPct = sessionPromptTokens > 0
    ? (sessionCachedPromptTokens / sessionPromptTokens) * 100
    : 0;

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

          {data.integrity?.truncated_to_session_request_count && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              This session key has {data.integrity.usage_rows_total.toLocaleString()} persisted usage rows, but the current session record reports{" "}
              {data.integrity.session_request_count.toLocaleString()} request(s). Showing the current session window to avoid mixing older rows from legacy/reused-key history.
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  User
                </dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  <span title={data.session.user_id}>
                    {data.session.user_display || data.session.username || data.session.user_id || "—"}
                  </span>
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
                  Tokens (prompt / completion / prefix-cached)
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fmtTokens(data.session.total_tokens_in)} /{" "}
                  {fmtTokens(data.session.total_tokens_out)} /{" "}
                  {fmtTokens(data.session.total_tokens_cached)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Prompt billed upstream (in - cached)
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fmtTokens(sessionEffectivePromptTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Prompt cache saved upstream
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-indigo-700 dark:text-indigo-300">
                  {fmtTokens(sessionCachedPromptTokens)} ({sessionPromptCacheHitPct.toFixed(1)}%)
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Tokens saved before upstream (reduction)
                </dt>
                <dd className="mt-1 text-sm tabular-nums text-green-600 dark:text-green-400">
                  {fmtTokens(data.session.total_tokens_saved ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" title="Configured model rate-card usage price">
                  Total price
                </dt>
                <dd
                  className="mt-1 text-sm tabular-nums text-gray-900 dark:text-gray-100"
                  title={
                    data.session.total_provider_actual_cost_usd != null
                      ? `Provider actual: ${fmtCost(data.session.total_provider_actual_cost_usd)}`
                      : "Configured usage price"
                  }
                >
                  {fmtCost(data.session.total_price_usd)}
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

          {forensicsSummary && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-5 dark:border-indigo-800 dark:bg-indigo-950/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                    Cache diagnostics
                  </h2>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    Derived from recent <code>request_forensics_v1</code> events for this session.
                  </p>
                </div>
                <span className="rounded-full border border-indigo-300 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">
                  {forensicsSnapshots.length} samples
                </span>
              </div>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border border-indigo-200 bg-white px-3 py-2 dark:border-indigo-800 dark:bg-indigo-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Latest cache hit
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-indigo-700 dark:text-indigo-200">
                    {(forensicsSummary.latest.cacheHitRatio * 100).toFixed(1)}%
                  </dd>
                </div>
                <div className="rounded-md border border-indigo-200 bg-white px-3 py-2 dark:border-indigo-800 dark:bg-indigo-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Latest prompt / cached
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                    {fmtTokens(forensicsSummary.latest.tokensIn)} / {fmtTokens(forensicsSummary.latest.tokensCached)}
                  </dd>
                </div>
                <div className="rounded-md border border-indigo-200 bg-white px-3 py-2 dark:border-indigo-800 dark:bg-indigo-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Avg LCP reuse
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                    {(forensicsSummary.avgLcpRatio * 100).toFixed(1)}%
                  </dd>
                </div>
                <div className="rounded-md border border-indigo-200 bg-white px-3 py-2 dark:border-indigo-800 dark:bg-indigo-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Avg tool payload chars
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                    {Math.round(forensicsSummary.avgToolChars).toLocaleString()}
                  </dd>
                </div>
              </dl>
              {forensicsSummary.cachedPlateauDetected && (
                <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                  Cached prompt tokens are flat ({fmtTokens(forensicsSummary.minCached)}-{fmtTokens(forensicsSummary.maxCached)})
                  while prompt volume keeps growing ({fmtTokens(forensicsSummary.minPrompt)}-{fmtTokens(forensicsSummary.maxPrompt)}).
                  This usually means only a small stable prefix is reusable.
                </p>
              )}
              {latestCapabilityResolution && (
                <p className={`mt-3 rounded-md border px-3 py-2 text-xs ${
                  latestCapabilityResolution.reducersEnabled
                  && latestCapabilityResolution.transcriptPruneEnabled
                  && latestCapabilityResolution.jsonCompactionEnabled
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
                    : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                }`}>
                  Capability matrix: mode={latestCapabilityResolution.mode}, global={latestCapabilityResolution.globalOptimizationsEnabled ? "on" : "off"}, matched overrides={latestCapabilityResolution.matchedOverrideCount}.{" "}
                  Reducers={latestCapabilityResolution.reducersEnabled ? "on" : "off"}, prune={latestCapabilityResolution.transcriptPruneEnabled ? "on" : "off"}, json-compaction={latestCapabilityResolution.jsonCompactionEnabled ? "on" : "off"}, dedupe={latestCapabilityResolution.contentDedupeEnabled ? "on" : "off"}.
                </p>
              )}
              <div className="mt-4 overflow-hidden rounded-md border border-indigo-200 dark:border-indigo-800">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-indigo-100 text-xs dark:divide-indigo-900">
                    <thead className="bg-indigo-50 dark:bg-indigo-900/40">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          Time
                        </th>
                        <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          Prompt
                        </th>
                        <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          Cached
                        </th>
                        <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          Hit %
                        </th>
                        <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          LCP %
                        </th>
                        <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          First change
                        </th>
                        <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
                          Tool chars
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-100 bg-white dark:divide-indigo-900 dark:bg-gray-950">
                      {forensicsSnapshots.slice(0, 8).map((row) => (
                        <tr key={row.eventId}>
                          <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">
                            {row.createdAt ? new Date(row.createdAt).toLocaleTimeString() : "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                            {fmtTokens(row.tokensIn)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-indigo-700 dark:text-indigo-300">
                            {fmtTokens(row.tokensCached)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                            {(row.cacheHitRatio * 100).toFixed(1)}%
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                            {(row.lcpRatio * 100).toFixed(1)}%
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">
                            {row.firstChangedSection || "—"}
                            {row.firstChangedIndex !== null ? ` @${row.firstChangedIndex}` : ""}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                            {row.toolChars.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {latestWorkPacket && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-5 dark:border-emerald-800 dark:bg-emerald-950/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                    Current work packet
                  </h2>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    Durable tail-state replay for architecture-aware sessions.
                  </p>
                </div>
                <span className={clsx(
                  "rounded-full border px-2.5 py-1 text-xs font-medium",
                  latestWorkPacket.injected
                    ? "border-emerald-300 bg-white text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                    : "border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200",
                )}>
                  {latestWorkPacket.injected ? "Injected" : "Observed"} · {latestWorkPacket.mode}
                </span>
              </div>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border border-emerald-200 bg-white px-3 py-2 dark:border-emerald-800 dark:bg-emerald-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Phase
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {latestWorkPacket.currentPhase}
                  </dd>
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-3 py-2 dark:border-emerald-800 dark:bg-emerald-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Hash
                  </dt>
                  <dd className="mt-1 font-mono text-sm text-gray-900 dark:text-gray-100">
                    {latestWorkPacket.hash || "—"}
                  </dd>
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-3 py-2 dark:border-emerald-800 dark:bg-emerald-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Token estimate
                  </dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                    {fmtTokens(latestWorkPacket.estimatedTokens)}
                  </dd>
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-3 py-2 dark:border-emerald-800 dark:bg-emerald-900/30">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Last update
                  </dt>
                  <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                    {latestWorkPacket.createdAt ? new Date(latestWorkPacket.createdAt).toLocaleString() : "—"}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Objective
                  </h3>
                  <p className="mt-1 rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm text-gray-800 dark:border-emerald-800 dark:bg-gray-950 dark:text-gray-200">
                    {latestWorkPacket.objective}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Next best action
                  </h3>
                  <p className="mt-1 rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm text-gray-800 dark:border-emerald-800 dark:bg-gray-950 dark:text-gray-200">
                    {latestWorkPacket.nextBestAction}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {latestWorkPacket.sourceSections.map((section) => (
                  <span key={section} className="rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200">
                    {section}
                  </span>
                ))}
                {latestWorkPacket.reasons.map((reason) => (
                  <span key={reason} className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                    {reason}
                  </span>
                ))}
              </div>
              {latestWorkPacket.block && (
                <pre className="mt-4 max-h-80 overflow-auto rounded-md border border-emerald-200 bg-white p-3 text-[11px] leading-5 text-gray-700 dark:border-emerald-800 dark:bg-gray-950 dark:text-gray-200">
                  {latestWorkPacket.block}
                </pre>
              )}
            </div>
          )}

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
                          Prompt
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Out
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Prefix-cached
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Effective Prompt
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Saved (reduction)
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Latency
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" title="Configured model rate-card usage price">
                          Price
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
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtTokens(Math.max(rq.tokens_in - rq.tokens_cached, 0))}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-green-600 dark:text-green-400">
                            {rq.tokens_saved_by_reduction ? fmtTokens(rq.tokens_saved_by_reduction) : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400">
                            {fmtDurationMs(rq.latency_ms)}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600 dark:text-gray-400"
                            title={
                              rq.provider_actual_cost_usd != null
                                ? `Provider actual: ${fmtCost(rq.provider_actual_cost_usd)}`
                                : "Configured usage price"
                            }
                          >
                            <span>{fmtCost(rq.price_usd)}</span>
                            {isFallbackPricing(rq.pricing_source) && (
                              <span className="ml-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/30 dark:text-amber-400 dark:ring-amber-500/30" title="Price derived from fallback base rates — set pricing in Model Registry">
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
                <button
                  type="button"
                  onClick={() => setSelectedPreset("edit_context_miss")}
                  className={clsx(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    selectedPreset === "edit_context_miss"
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  Edit anchor misses ({diagnosticPresetCount(data.events, "edit_context_miss")})
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPreset("transition_quality_risk")}
                  className={clsx(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    selectedPreset === "transition_quality_risk"
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/40 dark:text-indigo-300"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  Transition quality risks ({diagnosticPresetCount(data.events, "transition_quality_risk")})
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
