import { useState } from "react";
import { useIngestionSources, useCreateIngestionSource } from "../../api/hooks";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { Plus, FolderOpen, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { IngestionSource } from "../../types";

const ACL_MODES = ["open", "restricted", "private"] as const;

export default function IngestionSources() {
  const { data, isLoading } = useIngestionSources();
  const createSource = useCreateIngestionSource();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: "",
    handler: "html_document",
    domain: "",
    authority: "vetted",
    origin_type: "curated",
    tags: "",
    visibility_scope: "global",
    org_id: "",
    tenant_id: "",
    acl_mode: "open",
    acl_groups: "",
  });

  const sources: IngestionSource[] = data?.sources ?? [];

  const handleCreate = () => {
    createSource.mutate(
      {
        name: form.name,
        handler: form.handler,
        domain: form.domain || undefined,
        authority: form.authority,
        origin_type: form.origin_type,
        tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
        visibility_scope: form.visibility_scope,
        org_id: form.org_id || undefined,
        tenant_id: form.tenant_id || undefined,
        acl_mode: form.acl_mode,
        acl_groups: form.acl_groups || undefined,
      },
      {
        onSuccess: () => {
          setShowCreate(false);
          setForm({
            name: "",
            handler: "html_document",
            domain: "",
            authority: "vetted",
            origin_type: "curated",
            tags: "",
            visibility_scope: "global",
            org_id: "",
            tenant_id: "",
            acl_mode: "open",
            acl_groups: "",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Ingestion Sources</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage named content sources with scope, ACL, and handler configuration
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> New Source
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">Create Source</h3>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Name *</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Company Docs"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Handler</span>
              <select
                value={form.handler}
                onChange={(e) => setForm({ ...form, handler: e.target.value })}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="html_document">HTML Document</option>
                <option value="web_page">Web Page (crawl)</option>
                <option value="pdf_document">PDF Document</option>
                <option value="markdown_document">Markdown</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Domain</span>
              <input
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="e.g. safety"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Authority</span>
              <select
                value={form.authority}
                onChange={(e) => setForm({ ...form, authority: e.target.value })}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="canonical">canonical</option>
                <option value="vetted">vetted</option>
                <option value="community">community</option>
                <option value="untrusted">untrusted</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Origin type</span>
              <select
                value={form.origin_type}
                onChange={(e) => setForm({ ...form, origin_type: e.target.value })}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="curated">curated</option>
                <option value="official">official</option>
                <option value="community">community</option>
                <option value="generated">generated</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Tags (comma-separated)</span>
              <input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="e.g. docs, internal"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </label>
          </div>

          <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Scope &amp; Access Control
            </h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Visibility scope</span>
                <select
                  value={form.visibility_scope}
                  onChange={(e) => setForm({ ...form, visibility_scope: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                >
                  <option value="global">global</option>
                  <option value="org">org</option>
                  <option value="tenant">tenant</option>
                  <option value="private">private</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Organization ID</span>
                <input
                  value={form.org_id}
                  onChange={(e) => setForm({ ...form, org_id: e.target.value })}
                  placeholder="auto from caller"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Tenant ID</span>
                <input
                  value={form.tenant_id}
                  onChange={(e) => setForm({ ...form, tenant_id: e.target.value })}
                  placeholder="optional"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">ACL mode</span>
                <select
                  value={form.acl_mode}
                  onChange={(e) => setForm({ ...form, acl_mode: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                >
                  {ACL_MODES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="col-span-full block sm:col-span-2">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                  ACL groups {form.acl_mode !== "open" && <span className="text-red-500">*</span>}
                </span>
                <input
                  value={form.acl_groups}
                  onChange={(e) => setForm({ ...form, acl_groups: e.target.value })}
                  placeholder="comma-separated group IDs (required for restricted/private)"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                />
              </label>
            </div>
          </div>

          <ApiErrorBanner error={createSource.error} onDismiss={() => createSource.reset()} />

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!form.name || createSource.isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {createSource.isPending ? "Creating..." : "Create Source"}
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

      {isLoading && (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      )}

      {!isLoading && sources.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center dark:border-gray-600">
          <FolderOpen className="mx-auto h-10 w-10 text-gray-400" />
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            No ingestion sources yet. Create one to organize content by source with scope and ACL policies.
          </p>
        </div>
      )}

      {sources.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {["Name", "Handler", "Domain", "Scope", "ACL", "Items", "Status", "Created", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {sources.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">{s.name}</div>
                    {s.org_id && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        org: {s.org_id}
                        {s.tenant_id && ` / tenant: ${s.tenant_id}`}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{s.handler}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{s.domain || "—"}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                      {s.visibility_scope}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <AclBadge mode={s.acl_mode} groups={s.acl_groups} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {s.item_count}
                    {s.pending_count > 0 && (
                      <span className="ml-1 text-xs text-yellow-600 dark:text-yellow-400">
                        ({s.pending_count} pending)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.status === "active"
                        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                        : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                    }`}>
                      {s.status || "active"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/rag/ingestion?source_id=${s.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400"
                    >
                      Items <ChevronRight className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AclBadge({ mode, groups }: { mode: string; groups: string }) {
  const colorMap: Record<string, string> = {
    open: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    restricted: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    private: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colorMap[mode] ?? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"}`}
      title={groups || undefined}
    >
      {mode || "open"}
      {groups && <span className="ml-1 opacity-70">({groups.split(",").length})</span>}
    </span>
  );
}
