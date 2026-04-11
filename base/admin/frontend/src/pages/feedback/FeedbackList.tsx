import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useFeedback,
  useFeedbackWorkspaceUpdate,
  useSyncOpenWebUIFeedback,
} from "../../api/hooks";
import { apiErrorMessage } from "../../api/errorMessage";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { useAuth } from "../../components/auth/useAuth";
import type { FeedbackEntry } from "../../types";

export default function FeedbackList() {
  const { isAdmin } = useAuth();
  const [vote, setVote] = useState<string>("");
  const [source, setSource] = useState<string>("all");
  const [reviewFilter, setReviewFilter] = useState<string>("");
  const [selected, setSelected] = useState<FeedbackEntry | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState<"pending" | "reviewed" | "closed">("pending");

  const { data, isLoading, error, refetch } = useFeedback({
    vote: vote || undefined,
    source: source === "all" ? undefined : source,
    review_status: reviewFilter || undefined,
    limit: 200,
  });
  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;

  const syncMutation = useSyncOpenWebUIFeedback();
  const workspaceMutation = useFeedbackWorkspaceUpdate();

  function openWorkspace(row: FeedbackEntry) {
    setSelected(row);
    setNoteDraft(String(row.internal_note ?? ""));
    setStatusDraft((row.review_status as "pending" | "reviewed" | "closed") || "pending");
  }

  function closeWorkspace() {
    setSelected(null);
  }

  function saveWorkspace() {
    if (!selected) return;
    const payload =
      selected.source === "planner"
        ? {
            source: "planner" as const,
            run_id: String(selected.run_id ?? ""),
            message_id: String(selected.message_id ?? ""),
            review_status: statusDraft,
            internal_note: noteDraft,
          }
        : {
            source: "openwebui" as const,
            owui_id: String(selected.owui_id ?? ""),
            review_status: statusDraft,
            internal_note: noteDraft,
          };
    workspaceMutation.mutate(payload, { onSuccess: closeWorkspace });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Chat Feedback</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Triage chat thumbs and Open WebUI ratings. Route retrieval issues to Retrieval Gaps and source
            recommendations to Curator.
          </p>
          {error && !isLoading ? (
            <p className="mt-2 text-sm text-red-600">{apiErrorMessage(error)}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <button
              type="button"
              disabled={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
            >
              {syncMutation.isPending ? "Syncing…" : "Sync from Open WebUI"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:text-gray-200"
          >
            Refresh
          </button>
        </div>
      </div>

      {syncMutation.isError ? (
        <p className="text-sm text-red-600">{apiErrorMessage(syncMutation.error)}</p>
      ) : null}
      {syncMutation.isSuccess ? (
        <p className="text-sm text-green-700 dark:text-green-400">
          Synced {String((syncMutation.data as { rows?: number })?.rows ?? 0)} feedback row(s) from Open
          WebUI.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
        >
          <option value="all">All sources</option>
          <option value="planner">Chat (classifier)</option>
          <option value="openwebui">Open WebUI</option>
        </select>
        <select
          value={vote}
          onChange={(e) => setVote(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
        >
          <option value="">All ratings</option>
          <option value="up">Positive</option>
          <option value="down">Negative</option>
        </select>
        <select
          value={reviewFilter}
          onChange={(e) => setReviewFilter(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
        >
          <option value="">All review states</option>
          <option value="pending">Pending</option>
          <option value="reviewed">Reviewed</option>
          <option value="closed">Closed</option>
        </select>
        <span className="self-center text-sm text-gray-500 dark:text-gray-400">
          {total} row{total === 1 ? "" : "s"}
        </span>
      </div>

      <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-3 text-sm text-indigo-900 dark:border-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-200">
        <span className="font-medium">Handoff:</span>{" "}
        <Link to="/rag/retrieval-gaps" className="underline underline-offset-2">
          Retrieval Gaps
        </Link>{" "}
        for confidence failures and{" "}
        <Link to="/rag/curator" className="underline underline-offset-2">
          Curator
        </Link>{" "}
        for proposed source additions.
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : entries.length === 0 ? (
        <EmptyState title="No feedback yet" />
      ) : (
        <DataTable
          columns={[
            {
              key: "source",
              label: "Source",
              render: (r) => (
                <span className="capitalize">
                  {r.source === "openwebui" ? "Open WebUI" : "Chat (classifier)"}
                </span>
              ),
            },
            {
              key: "vote",
              label: "Rating",
              render: (r) =>
                r.vote === "up" || r.vote === "down" ? (
                  <StatusBadge status={r.vote} />
                ) : (
                  <span className="text-gray-400">—</span>
                ),
            },
            {
              key: "review_status",
              label: "Review",
              render: (r) => {
                const s = (r.review_status as string) || "pending";
                if (s === "reviewed") return <StatusBadge status="adequate" label="reviewed" />;
                if (s === "closed") return <StatusBadge status="closed" />;
                return <StatusBadge status="pending" />;
              },
            },
            {
              key: "message_snippet",
              label: "Message",
              className: "max-w-xs truncate whitespace-nowrap",
            },
            {
              key: "tags",
              label: "Tags",
              render: (r) =>
                Array.isArray(r.tags) && r.tags.length ? (
                  <span className="text-xs text-gray-600 dark:text-gray-300">{r.tags.slice(0, 3).join(", ")}</span>
                ) : (
                  <span className="text-gray-400">—</span>
                ),
            },
            {
              key: "model",
              label: "Model",
            },
            {
              key: "message_id",
              label: "Msg ID",
              className: "max-w-[8rem] truncate font-mono text-xs",
              render: (r) => {
                const mid = String(r.message_id ?? "");
                if (!mid) return <span className="text-gray-400">—</span>;
                const short = mid.length > 14 ? `${mid.slice(0, 12)}…` : mid;
                return <span title={mid}>{short}</span>;
              },
            },
            {
              key: "run_id",
              label: "Trace",
              render: (r) =>
                r.run_id ? (
                  <Link
                    to={`/traces/${r.run_id}`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open
                  </Link>
                ) : (
                  <span className="text-gray-400">—</span>
                ),
            },
            { key: "timestamp", label: "Time", sortable: true },
          ]}
          data={entries}
          keyField="id"
          onRowClick={(r) => openWorkspace(r)}
        />
      )}

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Feedback workspace</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {selected.source === "planner" ? "Chat (classifier) vote" : "Open WebUI evaluation"}
            </p>

            <div className="mt-4 space-y-3 text-sm">
              {selected.reason ? (
                <div>
                  <div className="text-xs font-medium uppercase text-gray-500">User reason</div>
                  <p className="mt-1 whitespace-pre-wrap text-gray-800 dark:text-gray-200">{selected.reason}</p>
                </div>
              ) : null}
              {selected.user_comment ? (
                <div>
                  <div className="text-xs font-medium uppercase text-gray-500">User comment</div>
                  <p className="mt-1 whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                    {selected.user_comment}
                  </p>
                </div>
              ) : null}
              {selected.response_snippet ? (
                <div>
                  <div className="text-xs font-medium uppercase text-gray-500">Response snippet</div>
                  <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                    {selected.response_snippet}
                  </p>
                </div>
              ) : null}
              {selected.run_id ? (
                <div>
                  <Link
                    to={`/traces/${selected.run_id}`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    View pipeline trace →
                  </Link>
                </div>
              ) : null}
            </div>

            {isAdmin ? (
              <div className="mt-4 space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Review status</span>
                  <select
                    value={statusDraft}
                    onChange={(e) => setStatusDraft(e.target.value as "pending" | "reviewed" | "closed")}
                    className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  >
                    <option value="pending">Pending</option>
                    <option value="reviewed">Reviewed</option>
                    <option value="closed">Closed</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Internal note</span>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={4}
                    className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    placeholder="Notes for your team (not sent to users)"
                  />
                </label>
                {workspaceMutation.isError ? (
                  <p className="text-sm text-red-600">{apiErrorMessage(workspaceMutation.error)}</p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeWorkspace}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:text-gray-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={workspaceMutation.isPending}
                    onClick={saveWorkspace}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-white dark:text-gray-900"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                Admin role required to change review status or internal notes.
              </p>
            )}

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeWorkspace}
                className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
