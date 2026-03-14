import { useState } from "react";
import { useKnowledgeGaps, useSubmitKnowledge } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import { useAuth } from "../../components/auth/AuthProvider";

export default function KnowledgeGaps() {
  const { data, isLoading } = useKnowledgeGaps();
  const gaps = data?.gaps ?? [];
  const { isAdmin } = useAuth();
  const submit = useSubmitKnowledge();
  const [domain, setDomain] = useState("");
  const [content, setContent] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!domain.trim() || !content.trim()) return;
    submit.mutate({ domain: domain.trim(), content: content.trim() }, {
      onSuccess: () => { setDomain(""); setContent(""); },
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Knowledge Gaps</h1>
        <p className="mt-1 text-sm text-gray-500">
          Queries with low RAG confidence -- fill gaps by submitting content
        </p>
      </div>

      {isAdmin && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-gray-200 bg-white p-5 space-y-3">
          <h3 className="text-sm font-medium text-gray-900">Submit Knowledge</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <input
              placeholder="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <textarea
              placeholder="Content to ingest..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={2}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm sm:col-span-2"
            />
            <button
              type="submit"
              disabled={submit.isPending}
              className="self-end rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submit.isPending ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : gaps.length === 0 ? (
        <EmptyState title="No knowledge gaps" />
      ) : (
        <DataTable
          columns={[
            { key: "query", label: "Query" },
            { key: "platform_context", label: "Domain", sortable: true },
            { key: "max_score", label: "Max Score", sortable: true, render: (r) => (r.max_score as number).toFixed(3) },
            { key: "language", label: "Language" },
            { key: "timestamp", label: "Time", sortable: true },
          ]}
          data={gaps}
          keyField="chunk_id"
        />
      )}
    </div>
  );
}
