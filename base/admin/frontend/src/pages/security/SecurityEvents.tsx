import { useState, useCallback } from "react";
import { clsx } from "clsx";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Shield,
} from "lucide-react";
import {
  useSecurityEvents,
  useResolveSecurityEvent,
  type SecurityEventRow,
} from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-blue-100 text-blue-700",
};

const ACTION_BADGE: Record<string, string> = {
  allow: "bg-green-100 text-green-800",
  warn: "bg-yellow-100 text-yellow-800",
  sanitize: "bg-blue-100 text-blue-800",
  block: "bg-red-100 text-red-800",
  freeze_token: "bg-red-200 text-red-900",
  restrict_tools: "bg-orange-100 text-orange-800",
  escalate: "bg-purple-100 text-purple-800",
};

const RESOLVE_OPTIONS = [
  { value: "acknowledge", label: "Acknowledge" },
  { value: "false_positive", label: "False positive" },
  { value: "suppress", label: "Suppress rule" },
  { value: "freeze_token", label: "Freeze token" },
  { value: "restrict_tools", label: "Restrict tools" },
];

function Badge({
  text,
  colorMap,
}: {
  text: string;
  colorMap: Record<string, string>;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        colorMap[text] ?? "bg-gray-100 text-gray-800",
      )}
    >
      {text.replace(/_/g, " ")}
    </span>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function EventRow({
  event,
  onResolve,
}: {
  event: SecurityEventRow;
  onResolve: (eventId: string, action: string, reason: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolveAction, setResolveAction] = useState("acknowledge");
  const [reason, setReason] = useState("");

  return (
    <div
      className={clsx(
        "border-b border-gray-100 transition-colors",
        event.resolved ? "bg-gray-50/50" : "bg-white",
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-gray-50"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400" />
        )}
        <Badge text={event.severity} colorMap={SEVERITY_BADGE} />
        <span className="flex-1 truncate text-gray-900">
          {event.event_type.replace(/_/g, " ")}
        </span>
        <Badge text={event.action_taken} colorMap={ACTION_BADGE} />
        <span className="w-16 text-xs text-gray-500">{event.service}</span>
        <span className="w-20 text-xs text-gray-400">
          {timeAgo(event.created_at)}
        </span>
        {event.resolved ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Clock className="h-4 w-4 text-amber-500" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-10 py-4">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Confidence:</span>{" "}
              <span className="font-medium">
                {(event.confidence * 100).toFixed(0)}% ({event.confidence_band})
              </span>
            </div>
            <div>
              <span className="text-gray-500">Scanner:</span>{" "}
              <span className="font-medium">{event.scanner_name}</span>
            </div>
            <div>
              <span className="text-gray-500">Latency:</span>{" "}
              <span className="font-medium">
                {event.latency_ms.toFixed(2)} ms
              </span>
            </div>
            {event.user_id && (
              <div>
                <span className="text-gray-500">User:</span>{" "}
                <span className="font-mono text-xs">{event.user_id}</span>
              </div>
            )}
            {event.session_id && (
              <div>
                <span className="text-gray-500">Session:</span>{" "}
                <span className="font-mono text-xs">{event.session_id}</span>
              </div>
            )}
            {event.token_id && (
              <div>
                <span className="text-gray-500">Token:</span>{" "}
                <span className="font-mono text-xs">{event.token_id}</span>
              </div>
            )}
          </div>

          {event.patterns_found.length > 0 && (
            <div className="mt-3">
              <span className="text-sm text-gray-500">Patterns:</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {event.patterns_found.map((p, i) => (
                  <span
                    key={i}
                    className="inline-flex rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {event.excerpt && (
            <div className="mt-3">
              <span className="text-sm text-gray-500">Excerpt:</span>
              <pre className="mt-1 max-h-24 overflow-auto rounded bg-gray-50 p-2 font-mono text-xs text-gray-800">
                {event.excerpt}
              </pre>
            </div>
          )}

          {event.resolved && (
            <div className="mt-3 rounded-md bg-green-50 p-3 text-sm">
              <span className="font-medium text-green-800">
                Resolved: {event.resolved_action}
              </span>
              <span className="text-green-700">
                {" "}
                by {event.resolved_by}
                {event.resolved_at
                  ? ` (${timeAgo(event.resolved_at)})`
                  : ""}
              </span>
              {event.resolved_reason && (
                <p className="mt-1 text-green-700">{event.resolved_reason}</p>
              )}
            </div>
          )}

          {!event.resolved && (
            <div className="mt-4 flex items-end gap-3 rounded-md border border-gray-200 bg-gray-50 p-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600">
                  Action
                </label>
                <select
                  value={resolveAction}
                  onChange={(e) => setResolveAction(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
                >
                  {RESOLVE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-[2]">
                <label className="block text-xs font-medium text-gray-600">
                  Reason
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Required: explain resolution"
                  className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
              </div>
              <button
                disabled={!reason.trim()}
                onClick={() => {
                  onResolve(event.event_id, resolveAction, reason);
                  setReason("");
                }}
                className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Resolve
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SecurityEvents() {
  const [severity, setSeverity] = useState<string>("");
  const [showResolved, setShowResolved] = useState<boolean | undefined>(
    undefined,
  );
  const { data, isLoading } = useSecurityEvents({
    severity: severity || undefined,
    resolved: showResolved,
    limit: 200,
  });
  const resolveMut = useResolveSecurityEvent();

  const handleResolve = useCallback(
    (eventId: string, action: string, reason: string) => {
      resolveMut.mutate({ event_id: eventId, action, reason });
    },
    [resolveMut],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">
          Security Events
        </h1>
        <div className="flex gap-2">
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            value={showResolved === undefined ? "" : String(showResolved)}
            onChange={(e) =>
              setShowResolved(
                e.target.value === "" ? undefined : e.target.value === "true",
              )
            }
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            <option value="false">Unresolved</option>
            <option value="true">Resolved</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 rounded bg-gray-100" />
          ))}
        </div>
      ) : !data?.events?.length ? (
        <EmptyState
          icon={Shield}
          title="No events found"
          description="No security events match the current filters"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium uppercase tracking-wider text-gray-500">
            <span className="w-4" />
            <span className="w-16">Severity</span>
            <span className="flex-1">Event type</span>
            <span className="w-20">Action</span>
            <span className="w-16">Service</span>
            <span className="w-20">When</span>
            <span className="w-4">Status</span>
          </div>
          {data.events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              onResolve={handleResolve}
            />
          ))}
        </div>
      )}
    </div>
  );
}
