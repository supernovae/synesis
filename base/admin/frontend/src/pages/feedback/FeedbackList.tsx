import { useState } from "react";
import { useFeedback } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

export default function FeedbackList() {
  const [vote, setVote] = useState<string>("");
  const { data, isLoading } = useFeedback({ vote: vote || undefined, limit: 100 });
  const entries = data?.entries ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Feedback</h1>
          <p className="mt-1 text-sm text-gray-500">User feedback on responses</p>
        </div>
        <select
          value={vote}
          onChange={(e) => setVote(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All votes</option>
          <option value="up">Thumbs up</option>
          <option value="down">Thumbs down</option>
        </select>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : entries.length === 0 ? (
        <EmptyState title="No feedback yet" />
      ) : (
        <DataTable
          columns={[
            { key: "vote", label: "Vote", render: (r) => <StatusBadge status={r.vote as "up" | "down"} /> },
            { key: "message_snippet", label: "Message" },
            { key: "model", label: "Model" },
            { key: "timestamp", label: "Time", sortable: true },
          ]}
          data={entries}
          keyField="run_id"
        />
      )}
    </div>
  );
}
