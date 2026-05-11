import { useCallback, useMemo, useState } from "react";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { PROMPT_MODEL_FAMILY_OPTIONS, PROMPT_MODEL_FAMILY_VALUE_SET } from "../../constants/promptModelFamilies";
import {
  useCreatePromptProfile,
  useDeletePromptAssignment,
  useDeletePromptProfile,
  usePromptAssignments,
  usePromptProfiles,
  useUpdatePromptProfile,
  useUpsertPromptAssignment,
} from "../../api/hooks";

type Service = "yarn" | "planner";
type TargetType = "default" | "tier" | "role" | "model_family" | "node";

const TARGET_TYPE_OPTIONS: TargetType[] = ["default", "tier", "role", "model_family", "node"];

function serviceHeadingLabel(s: Service): string {
  return s === "yarn" ? "Coder (yarn-ts)" : "Chat (planner-ts)";
}

export default function PromptLibrary() {
  const [service, setService] = useState<Service>("yarn");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [editId, setEditId] = useState<number | null>(null);

  const [assignTargetType, setAssignTargetType] = useState<TargetType>("default");
  const [assignTargetValue, setAssignTargetValue] = useState("*");
  const [assignProfileId, setAssignProfileId] = useState<number>(0);

  const profilesQ = usePromptProfiles(service);
  const assignmentsQ = usePromptAssignments(service);
  const createProfile = useCreatePromptProfile();
  const updateProfile = useUpdatePromptProfile();
  const deleteProfile = useDeletePromptProfile();
  const upsertAssignment = useUpsertPromptAssignment();
  const deleteAssignment = useDeletePromptAssignment();

  const profiles = useMemo(
    () => profilesQ.data?.profiles ?? [],
    [profilesQ.data?.profiles],
  );
  const assignments = assignmentsQ.data?.assignments ?? [];

  const profileById = useMemo(() => {
    const out = new Map<number, { id: number; name: string; content_hash: string }>();
    for (const p of profiles) out.set(p.id, p);
    return out;
  }, [profiles]);

  const resetEditor = () => {
    setEditId(null);
    setName("");
    setDescription("");
    setContent("");
  };

  const resetAssignmentForm = () => {
    setAssignTargetType("default");
    setAssignTargetValue("*");
    setAssignProfileId(0);
  };

  const isEditorDirty = useCallback(() => {
    if (editId) {
      const p = profiles.find((row) => row.id === editId);
      if (!p) return true;
      return name !== p.name || description !== p.description || content !== p.content;
    }
    return name.trim() !== "" || description.trim() !== "" || content.trim() !== "";
  }, [editId, profiles, name, description, content]);

  const switchService = (next: Service) => {
    if (next === service) return;
    if (isEditorDirty()) {
      const ok = window.confirm(
        "You have unsaved changes in the profile editor. Switch anyway? Your edits will be discarded.",
      );
      if (!ok) return;
    }
    setService(next);
    resetEditor();
    resetAssignmentForm();
  };

  const saveProfile = () => {
    const payload = { service, name: name.trim(), description: description.trim(), content };
    if (!payload.name || !payload.content.trim()) return;
    if (editId) {
      updateProfile.mutate({ id: editId, ...payload }, { onSuccess: () => resetEditor() });
    } else {
      createProfile.mutate(payload, { onSuccess: () => resetEditor() });
    }
  };

  const applyProfileToEditor = (id: number) => {
    const p = profiles.find((row) => row.id === id);
    if (!p) return;
    setEditId(p.id);
    setName(p.name);
    setDescription(p.description);
    setContent(p.content);
  };

  const saveAssignment = () => {
    if (!assignProfileId) return;
    const targetValue =
      assignTargetType === "model_family"
        ? (PROMPT_MODEL_FAMILY_VALUE_SET.has(assignTargetValue) ? assignTargetValue : "generic")
        : (assignTargetValue || "").trim() || (assignTargetType === "default" ? "*" : "");
    if (!targetValue) return;
    upsertAssignment.mutate({
      service,
      target_type: assignTargetType,
      target_value: targetValue,
      profile_id: assignProfileId,
      enabled: true,
    });
  };

  const scopeLabel = serviceHeadingLabel(service);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Prompt Library</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Each tab is a separate service scope: Coder
          (IDE agent runtime, yarn-ts) vs Chat (planning step, planner-ts). Profile names use{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">&lt;service&gt;-default-base</code> for
          the catch-all default in that scope—so{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">yarn-default-base</code> and{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">planner-default-base</code> are the same
          pattern; <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">planner</code> in the filename is the internal service key, not a mistake. Coder also ships extra overlays (e.g. coder
          models) beside that default.
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Switching Coder / Chat clears the profile editor and assignment form; unsaved profile edits prompt before discard.
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          <span className="font-medium text-gray-700 dark:text-gray-300">Model family assignments:</span> use the{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">kimi</code> slug (lowercase) for Kimi
          / Moonshot — the runtime matches the same value produced by the model router (not the display name{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">Kimi</code> or free text). Choosing{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] dark:bg-gray-800">model_family</code> below uses a
          picklist of those slugs.
        </p>
        {service === "planner" && (
          <p className="mt-2 text-sm text-amber-900 dark:text-amber-100/90">
            <span className="font-medium">Chat tab:</span> Assigned profiles are{" "}
            <strong>appended after</strong> the built-in Chat planning system text (JSON schema, trust rules,
            taxonomy). They do not replace it. Use profiles for tone and model-family habits (e.g. Kimi);
            avoid asking for prose or markdown answers — the pipeline requires parseable JSON. The server
            also appends a final JSON-only reminder after all profiles.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => switchService("yarn")}
          className={`rounded px-3 py-1.5 text-sm ${service === "yarn" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"}`}
        >
          Coder
        </button>
        <button
          type="button"
          onClick={() => switchService("planner")}
          className={`rounded px-3 py-1.5 text-sm ${service === "planner" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"}`}
        >
          Chat
        </button>
      </div>

      <ApiErrorBanner error={profilesQ.error || assignmentsQ.error || createProfile.error || updateProfile.error || upsertAssignment.error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            {editId ? "Edit prompt profile" : "Create prompt profile"} — {scopeLabel}
          </h2>
          <div className="mt-3 space-y-3">
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              Name
              <input
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              Description
              <input
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              Prompt Content
              <textarea
                className="mt-1 h-48 w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <button
                onClick={saveProfile}
                disabled={createProfile.isPending || updateProfile.isPending || !name.trim() || !content.trim()}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {editId ? "Update" : "Create"}
              </button>
              {editId && (
                <button
                  onClick={resetEditor}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Assignments — {scopeLabel}</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <select
              value={assignTargetType}
              onChange={(e) => {
                const next = e.target.value as TargetType;
                const prev = assignTargetType;
                setAssignTargetType(next);
                if (next === "default") {
                  setAssignTargetValue("*");
                } else if (next === "model_family") {
                  setAssignTargetValue("generic");
                } else if (prev === "model_family") {
                  if (next === "tier") setAssignTargetValue("synesis-core");
                  else if (next === "role") setAssignTargetValue("coder-core");
                  else if (next === "node") setAssignTargetValue("");
                }
              }}
              className="rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              {TARGET_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {assignTargetType === "model_family" ? (
              <select
                value={PROMPT_MODEL_FAMILY_VALUE_SET.has(assignTargetValue) ? assignTargetValue : "generic"}
                onChange={(e) => setAssignTargetValue(e.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                title="Must match yarn-ts / planner-ts inferModelFamily() slugs"
              >
                {PROMPT_MODEL_FAMILY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={assignTargetValue}
                onChange={(e) => setAssignTargetValue(e.target.value)}
                placeholder={assignTargetType === "default" ? "*" : "target value"}
                className="rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              />
            )}
            <select
              value={assignProfileId || ""}
              onChange={(e) => setAssignProfileId(Number(e.target.value))}
              className="rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 md:col-span-2"
            >
              <option value="">Select profile</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={saveAssignment}
            disabled={upsertAssignment.isPending || !assignProfileId}
            className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Save assignment
          </button>

          <div className="mt-4 space-y-2">
            {assignments.map((a) => {
              const profile = profileById.get(a.profile_id);
              return (
                <div key={a.id} className="rounded border border-gray-200 px-3 py-2 text-xs dark:border-gray-700">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium text-gray-800 dark:text-gray-200">
                        {a.target_type}:{a.target_value}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400">
                        {profile?.name ?? `profile #${a.profile_id}`} · {profile?.content_hash?.slice(0, 12) ?? "no-hash"}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteAssignment.mutate(a.id)}
                      className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          Profiles — {scopeLabel} ({profiles.length})
        </h2>
        <div className="mt-3 space-y-2">
          {profiles.map((p) => (
            <div key={p.id} className="rounded border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</div>
                  <div className="truncate text-xs text-gray-500 dark:text-gray-400">{p.description || "No description"}</div>
                  <div className="mt-1 text-[11px] text-gray-400">hash {p.content_hash.slice(0, 16)}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => applyProfileToEditor(p.id)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteProfile.mutate(p.id)}
                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
          {!profilesQ.isLoading && profiles.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">No profiles for this service yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
