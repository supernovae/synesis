import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Search } from "lucide-react";
import client from "../../api/client";

export default function EffectivePermissions() {
  const [userId, setUserId] = useState("");
  const [searchId, setSearchId] = useState("");

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["effective-permissions", searchId],
    queryFn: () => client.get(`/acl/effective-permissions/${encodeURIComponent(searchId)}`).then((r) => r.data),
    enabled: !!searchId,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Effective Permissions</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Look up which ACL groups and policies apply to a specific user
        </p>
      </div>

      <div className="flex gap-3">
        <input
          placeholder="Enter user ID"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && userId.trim()) setSearchId(userId.trim()); }}
          className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
        <button
          onClick={() => { if (userId.trim()) setSearchId(userId.trim()); }}
          disabled={!userId.trim()}
          className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Search className="h-4 w-4" /> Look Up
        </button>
      </div>

      {(isLoading || isFetching) && <p className="text-sm text-gray-500">Loading permissions...</p>}
      {error && <p className="text-sm text-red-600">Failed to load permissions</p>}

      {data && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-3 flex items-center gap-2 font-medium text-gray-900 dark:text-white">
              <Eye className="h-4 w-4" /> Groups for {data.user_id}
            </h3>
            {data.groups?.length > 0 ? (
              <div className="space-y-1">
                {data.groups.map((g: { group_id: string; name: string; org_id: string }) => (
                  <div key={g.group_id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 dark:bg-gray-900">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-200">{g.name}</span>
                    <span className="text-xs text-gray-400">{g.group_id} {g.org_id && `· ${g.org_id}`}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">Not a member of any ACL groups</p>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-3 font-medium text-gray-900 dark:text-white">Applicable Policies</h3>
            {data.applicable_policies?.length > 0 ? (
              <div className="space-y-1">
                {data.applicable_policies.map((p: { id: number; name: string; effect: string; scope: string }) => (
                  <div key={p.id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 dark:bg-gray-900">
                    <span className="text-sm text-gray-900 dark:text-gray-200">{p.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">{p.scope}</span>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${p.effect === "allow" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"}`}>
                        {p.effect}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No policies apply to this user through their group memberships</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
