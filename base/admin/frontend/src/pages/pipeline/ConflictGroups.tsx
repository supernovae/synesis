import { useState } from "react";
import {
  useConflictGroups,
  useConflictGroupStats,
  useReviewConflictGroup,
  useDeleteConflictGroup,
} from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import { useAuth } from "../../components/auth/useAuth";
import type { ConflictGroup } from "../../types";

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending_review: {
    label: "Pending",
    className: "bg-yellow-100 text-yellow-800",
  },
  approved: { label: "Approved", className: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800" },
};

export default function ConflictGroups() {
  const [statusFilter, setStatusFilter] = useState("");
  const { data, isLoading } = useConflictGroups({
    status: statusFilter || undefined,
  });
  const { data: stats } = useConflictGroupStats();
  const groups = data?.groups ?? [];
  const { isAdmin } = useAuth();
  const review = useReviewConflictGroup();
  const remove = useDeleteConflictGroup();

  const columns: {
    key: string;
    label: string;
    sortable?: boolean;
    className?: string;
    render?: (row: ConflictGroup) => React.ReactNode;
  }[] = [
    {
      key: "group_name",
      label: "Group",
      render: (row) => (
        <span className="font-medium">{row.group_name}</span>
      ),
    },
    {
      key: "members",
      label: "Members",
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.members.map((m) => (
            <span
              key={m}
              className="inline-block rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
            >
              {m}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "default_pick",
      label: "Default",
      render: (row) =>
        row.default_pick ? (
          <span className="text-sm font-medium text-emerald-700">
            {row.default_pick}
          </span>
        ) : (
          <span className="text-xs text-gray-400">none</span>
        ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => {
        const badge = STATUS_BADGES[row.status] ?? {
          label: row.status,
          className: "bg-gray-100 text-gray-800",
        };
        return (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
        );
      },
    },
    {
      key: "source_query",
      label: "Source Query",
      render: (row) => (
        <span className="max-w-xs truncate text-xs text-gray-500" title={row.source_query}>
          {row.source_query.slice(0, 80)}
          {row.source_query.length > 80 ? "..." : ""}
        </span>
      ),
    },
    {
      key: "discovered_at",
      label: "Discovered",
      render: (row) => {
        const d = row.discovered_at ? new Date(row.discovered_at) : null;
        return (
          <span className="text-xs text-gray-500">
            {d ? d.toLocaleDateString() : ""}
          </span>
        );
      },
    },
  ];

  if (isAdmin) {
    columns.push({
      key: "_actions",
      label: "Actions",
      render: (row) => {
        const id = row.id;
        const st = row.status;
        return (
          <div className="flex gap-1">
            {st === "pending_review" && (
              <>
                <button
                  className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                  onClick={() => review.mutate({ id, status: "approved" })}
                >
                  Approve
                </button>
                <button
                  className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                  onClick={() => review.mutate({ id, status: "rejected" })}
                >
                  Reject
                </button>
              </>
            )}
            {st === "rejected" && (
              <button
                className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                onClick={() => review.mutate({ id, status: "approved" })}
              >
                Approve
              </button>
            )}
            {st === "approved" && (
              <button
                className="rounded bg-yellow-600 px-2 py-1 text-xs text-white hover:bg-yellow-700"
                onClick={() => review.mutate({ id, status: "rejected" })}
              >
                Revoke
              </button>
            )}
            <button
              className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-300"
              onClick={() => remove.mutate(id)}
            >
              Delete
            </button>
          </div>
        );
      },
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Discovered Conflict Groups</h2>
        <p className="mt-1 text-sm text-gray-500">
          Technology conflict groups discovered by the LLM fallback during anchor
          resolution. Approve groups to promote them to the fast deterministic
          path on next planner restart.
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total", value: stats.total, color: "text-gray-900" },
            {
              label: "Pending Review",
              value: stats.pending_review,
              color: "text-yellow-600",
            },
            {
              label: "Approved",
              value: stats.approved,
              color: "text-green-600",
            },
            {
              label: "Rejected",
              value: stats.rejected,
              color: "text-red-600",
            },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border bg-white p-4 shadow-sm"
            >
              <div className="text-sm text-gray-500">{s.label}</div>
              <div className={`mt-1 text-2xl font-bold ${s.color}`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {["", "pending_review", "approved", "rejected"].map((s) => (
          <button
            key={s}
            className={`rounded px-3 py-1 text-sm ${
              statusFilter === s
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            onClick={() => setStatusFilter(s)}
          >
            {s === "" ? "All" : STATUS_BADGES[s]?.label ?? s}
          </button>
        ))}
      </div>

      {groups.length === 0 && !isLoading ? (
        <EmptyState
          title="No conflict groups discovered yet"
          description="When the planner encounters unfamiliar technology choices, it will discover and persist new conflict groups here for review."
        />
      ) : (
        <DataTable
          columns={columns}
          data={groups}
          keyField="id"
        />
      )}
    </div>
  );
}
