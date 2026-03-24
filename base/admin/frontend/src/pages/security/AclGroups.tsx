import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Shield, Trash2, Users, ChevronDown, ChevronRight } from "lucide-react";
import client from "../../api/client";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

interface AclGroup {
  id: number;
  group_id: string;
  name: string;
  description: string;
  org_id: string;
  source: string;
  keycloak_group_path: string | null;
  member_count: number;
}

interface GroupMember {
  user_id: string;
  granted_by: string;
  granted_at: string;
}

export default function AclGroups() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState({ name: "", description: "", org_id: "", keycloak_group_path: "" });
  const [newMemberUserId, setNewMemberUserId] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["acl-groups"],
    queryFn: () => client.get("/acl/groups").then((r) => r.data),
  });

  const { data: membersData } = useQuery({
    queryKey: ["acl-group-members", expandedGroup],
    queryFn: () => client.get(`/acl/groups/${expandedGroup}/members`).then((r) => r.data),
    enabled: !!expandedGroup,
  });

  const createGroup = useMutation({
    mutationFn: (body: typeof newGroup) => client.post("/acl/groups", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acl-groups"] });
      setShowCreate(false);
      setNewGroup({ name: "", description: "", org_id: "", keycloak_group_path: "" });
    },
  });

  const deleteGroup = useMutation({
    mutationFn: (groupId: string) => client.delete(`/acl/groups/${groupId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["acl-groups"] }),
  });

  const addMember = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      client.post(`/acl/groups/${groupId}/members`, { user_id: userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acl-group-members", expandedGroup] });
      queryClient.invalidateQueries({ queryKey: ["acl-groups"] });
      setNewMemberUserId("");
    },
  });

  const removeMember = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      client.delete(`/acl/groups/${groupId}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acl-group-members", expandedGroup] });
      queryClient.invalidateQueries({ queryKey: ["acl-groups"] });
    },
  });

  const groups: AclGroup[] = data?.groups ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">ACL Groups</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage access control groups for per-document authorization
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> New Group
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 font-medium text-gray-900 dark:text-white">Create ACL Group</h3>
          <div className="grid grid-cols-2 gap-4">
            <input
              placeholder="Group name"
              value={newGroup.name}
              onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="Organization ID (optional)"
              value={newGroup.org_id}
              onChange={(e) => setNewGroup({ ...newGroup, org_id: e.target.value })}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="Description"
              value={newGroup.description}
              onChange={(e) => setNewGroup({ ...newGroup, description: e.target.value })}
              className="col-span-2 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <input
              placeholder="Keycloak group path (optional)"
              value={newGroup.keycloak_group_path}
              onChange={(e) => setNewGroup({ ...newGroup, keycloak_group_path: e.target.value })}
              className="col-span-2 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>
          <ApiErrorBanner error={createGroup.error} onDismiss={() => createGroup.reset()} />
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => createGroup.mutate(newGroup)}
              disabled={!newGroup.name || createGroup.isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {createGroup.isPending ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && <p className="text-sm text-gray-500">Loading groups...</p>}
      <ApiErrorBanner error={error} />
      <ApiErrorBanner error={deleteGroup.error} onDismiss={() => deleteGroup.reset()} />
      <ApiErrorBanner error={addMember.error} onDismiss={() => addMember.reset()} />
      <ApiErrorBanner error={removeMember.error} onDismiss={() => removeMember.reset()} />

      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.group_id} className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <div
              className="flex cursor-pointer items-center justify-between p-4"
              onClick={() => setExpandedGroup(expandedGroup === g.group_id ? null : g.group_id)}
            >
              <div className="flex items-center gap-3">
                {expandedGroup === g.group_id ? (
                  <ChevronDown className="h-4 w-4 text-gray-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-gray-400" />
                )}
                <Shield className="h-5 w-5 text-blue-500" />
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">{g.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {g.group_id} {g.org_id && `· org: ${g.org_id}`} {g.source !== "admin" && `· ${g.source}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1 text-sm text-gray-500">
                  <Users className="h-4 w-4" /> {g.member_count}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete group "${g.name}"?`)) deleteGroup.mutate(g.group_id);
                  }}
                  className="text-red-400 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            {expandedGroup === g.group_id && (
              <div className="border-t border-gray-200 p-4 dark:border-gray-700">
                <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Members</h4>
                <div className="space-y-1">
                  {(membersData?.members ?? []).map((m: GroupMember) => (
                    <div key={m.user_id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 dark:bg-gray-900">
                      <span className="text-sm text-gray-900 dark:text-gray-200">{m.user_id}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-400">by {m.granted_by}</span>
                        <button
                          onClick={() => removeMember.mutate({ groupId: g.group_id, userId: m.user_id })}
                          className="text-red-400 hover:text-red-600"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <input
                    placeholder="User ID to add"
                    value={newMemberUserId}
                    onChange={(e) => setNewMemberUserId(e.target.value)}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  />
                  <button
                    onClick={() => {
                      if (newMemberUserId.trim()) addMember.mutate({ groupId: g.group_id, userId: newMemberUserId.trim() });
                    }}
                    disabled={!newMemberUserId.trim()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!isLoading && groups.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-600">
            <Shield className="mx-auto h-8 w-8 text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No ACL groups yet. Create one to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
