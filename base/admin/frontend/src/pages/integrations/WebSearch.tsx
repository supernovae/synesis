import { useState } from "react";
import {
  useWebSearchStats,
  useWebSearchLog,
  useWebSearchDomains,
  useWebSearchPolicies,
  useCreateWebSearchPolicy,
  useDeleteWebSearchPolicy,
  useIngestWebUrl,
} from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import {
  Search,
  Globe,
  ShieldCheck,
  ShieldBan,
  Download,
  Trash2,
  Plus,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";

type Tab = "log" | "domains" | "policies";

export default function WebSearch() {
  const [tab, setTab] = useState<Tab>("log");
  const [logPage, setLogPage] = useState(1);
  const [domainFilter, setDomainFilter] = useState("");
  const [queryFilter, setQueryFilter] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState("");
  const [requestIdFilter, setRequestIdFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");

  const { data: stats, isLoading: statsLoading } = useWebSearchStats();
  const { data: logData } = useWebSearchLog({
    page: logPage,
    page_size: 25,
    domain: domainFilter || undefined,
    source_surface: surfaceFilter || undefined,
    request_id: requestIdFilter || undefined,
    session_key: sessionFilter || undefined,
    q: queryFilter || undefined,
  });
  const { data: domainData } = useWebSearchDomains();
  const { data: policyData } = useWebSearchPolicies();

  const createPolicy = useCreateWebSearchPolicy();
  const deletePolicy = useDeleteWebSearchPolicy();
  const ingestUrl = useIngestWebUrl();

  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [policyForm, setPolicyForm] = useState({
    url_pattern: "",
    policy: "allow",
    reason: "",
    boost_factor: 1.0,
    auto_ingest: false,
  });

  function handleCreatePolicy() {
    if (!policyForm.url_pattern.trim()) return;
    createPolicy.mutate(policyForm, {
      onSuccess: () => {
        setShowPolicyForm(false);
        setPolicyForm({ url_pattern: "", policy: "allow", reason: "", boost_factor: 1.0, auto_ingest: false });
      },
    });
  }

  function handleVet(url: string, domain: string) {
    createPolicy.mutate({
      url_pattern: url || domain,
      policy: "vetted",
      reason: "Vetted from search log",
      boost_factor: 1.3,
    });
  }

  function handleBlock(url: string, domain: string) {
    createPolicy.mutate({
      url_pattern: domain || url,
      policy: "block",
      reason: "Blocked from search log",
    });
  }

  function handleIngest(url: string, title: string) {
    ingestUrl.mutate({ url, title, reason: "Ingested from web search log" });
  }

  function fmtTs(ts: number) {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "log", label: "Search Log" },
    { id: "domains", label: "Domains" },
    { id: "policies", label: "Policies" },
  ];

  const totalPages = logData ? Math.ceil(logData.total / logData.page_size) : 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Web Search</h1>
        <p className="mt-1 text-sm text-gray-500">
          SearXNG integration metrics, search log, and HITL review
        </p>
      </div>

      {/* Metric Cards */}
      {statsLoading ? (
        <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
      ) : !stats ? (
        <EmptyState title="No web search data" icon={Search} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard label="Total Searches" value={stats.total ?? 0} icon={Search} />
          <MetricCard
            label="Avg Latency"
            value={stats.avg_latency_ms != null ? `${stats.avg_latency_ms.toFixed(0)}ms` : "—"}
          />
          <MetricCard
            label="Error Rate"
            value={stats.error_rate != null ? `${(stats.error_rate * 100).toFixed(1)}%` : "0%"}
          />
        </div>
      )}

      {/* Tab Bar */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium ${
                tab === t.id
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {tab === "log" && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Query</label>
              <input
                type="text"
                placeholder="Search queries..."
                value={queryFilter}
                onChange={(e) => { setQueryFilter(e.target.value); setLogPage(1); }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Domain</label>
              <input
                type="text"
                placeholder="e.g. arxiv.org"
                value={domainFilter}
                onChange={(e) => { setDomainFilter(e.target.value); setLogPage(1); }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Source Surface</label>
              <input
                type="text"
                placeholder="e.g. yarn_chat (Coder in-chat)"
                value={surfaceFilter}
                onChange={(e) => { setSurfaceFilter(e.target.value); setLogPage(1); }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Request ID</label>
              <input
                type="text"
                placeholder="trace/request id"
                value={requestIdFilter}
                onChange={(e) => { setRequestIdFilter(e.target.value); setLogPage(1); }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Session Key</label>
              <input
                type="text"
                placeholder="conversation:..."
                value={sessionFilter}
                onChange={(e) => { setSessionFilter(e.target.value); setLogPage(1); }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Log table */}
          {logData && logData.items.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <DataTable
                  keyField="id"
                  data={logData.items}
                  columns={[
                    {
                      key: "timestamp",
                      label: "Time",
                      sortable: true,
                      render: (r) => <span className="text-xs">{fmtTs(r.timestamp)}</span>,
                    },
                    {
                      key: "query",
                      label: "Query",
                      render: (r) => (
                        <span className="max-w-[200px] truncate block text-xs" title={r.query}>
                          {r.query.length > 60 ? r.query.slice(0, 60) + "…" : r.query}
                        </span>
                      ),
                    },
                    {
                      key: "domain",
                      label: "Domain",
                      sortable: true,
                      render: (r) => (
                        <span className="text-xs font-mono">{r.domain || "—"}</span>
                      ),
                    },
                    {
                      key: "source_surface",
                      label: "Surface",
                      render: (r) => <span className="text-xs font-mono">{r.source_surface || "—"}</span>,
                    },
                    {
                      key: "tool_name",
                      label: "Tool",
                      render: (r) => <span className="text-xs font-mono">{r.tool_name || "—"}</span>,
                    },
                    {
                      key: "request_id",
                      label: "Request",
                      render: (r) => (
                        <span className="max-w-[140px] truncate block text-xs font-mono" title={r.request_id}>
                          {r.request_id || "—"}
                        </span>
                      ),
                    },
                    {
                      key: "title",
                      label: "Title",
                      render: (r) =>
                        r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-indigo-600 hover:underline max-w-[180px] truncate block"
                            title={r.title || r.url}
                          >
                            {r.title || r.url.slice(0, 50)}
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        ),
                    },
                    {
                      key: "latency_ms",
                      label: "Latency",
                      sortable: true,
                      render: (r) => <span className="text-xs">{r.latency_ms.toFixed(0)}ms</span>,
                    },
                    {
                      key: "policy_action",
                      label: "Policy",
                      render: (r) => <span className="text-xs">{r.policy_action || "allow"}</span>,
                    },
                    {
                      key: "outcome",
                      label: "Status",
                      render: (r) => (
                        <StatusBadge
                          status={r.outcome === "success" ? "ok" : "error"}
                          label={r.outcome}
                        />
                      ),
                    },
                    {
                      key: "actions",
                      label: "Actions",
                      render: (r) =>
                        r.url ? (
                          <div className="flex items-center gap-1">
                            <button
                              title="Vet (boost ranking)"
                              onClick={(e) => { e.stopPropagation(); handleVet(r.url, r.domain); }}
                              className="rounded p-1 text-green-600 hover:bg-green-50"
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                            </button>
                            <button
                              title="Block domain"
                              onClick={(e) => { e.stopPropagation(); handleBlock(r.url, r.domain); }}
                              className="rounded p-1 text-red-600 hover:bg-red-50"
                            >
                              <ShieldBan className="h-3.5 w-3.5" />
                            </button>
                            <button
                              title="Ingest into RAG"
                              onClick={(e) => { e.stopPropagation(); handleIngest(r.url, r.title); }}
                              className="rounded p-1 text-indigo-600 hover:bg-indigo-50"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : null,
                    },
                  ]}
                />
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {logData.total} result{logData.total !== 1 && "s"} — page {logPage} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={logPage <= 1}
                    onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" /> Prev
                  </button>
                  <button
                    disabled={logPage >= totalPages}
                    onClick={() => setLogPage((p) => p + 1)}
                    className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm disabled:opacity-40"
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <EmptyState title="No search events yet" icon={Search} />
          )}
        </div>
      )}

      {tab === "domains" && (
        <div className="space-y-4">
          {domainData && domainData.domains.length > 0 ? (
            <DataTable
              keyField="domain"
              data={domainData.domains}
              columns={[
                {
                  key: "domain",
                  label: "Domain",
                  sortable: true,
                  render: (r) => (
                    <div className="flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5 text-gray-400" />
                      <span className="font-mono text-xs">{r.domain}</span>
                    </div>
                  ),
                },
                { key: "count", label: "Searches", sortable: true },
                {
                  key: "avg_latency_ms",
                  label: "Avg Latency",
                  sortable: true,
                  render: (r) => {
                    const slow = r.avg_latency_ms > 3000;
                    return (
                      <span className={`text-xs ${slow ? "text-amber-600 font-semibold" : ""}`}>
                        {r.avg_latency_ms.toFixed(0)}ms
                        {slow && <AlertTriangle className="inline ml-1 h-3 w-3" />}
                      </span>
                    );
                  },
                },
                {
                  key: "error_count",
                  label: "Errors",
                  sortable: true,
                  render: (r) =>
                    r.error_count > 0 ? (
                      <span className="text-red-600 font-medium">{r.error_count}</span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    ),
                },
                {
                  key: "last_seen",
                  label: "Last Seen",
                  sortable: true,
                  render: (r) => <span className="text-xs">{fmtTs(r.last_seen)}</span>,
                },
                {
                  key: "actions",
                  label: "",
                  render: (r) => (
                    <div className="flex items-center gap-1">
                      <button
                        title="Vet domain"
                        onClick={() => handleVet("", r.domain)}
                        className="rounded p-1 text-green-600 hover:bg-green-50"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Block domain"
                        onClick={() => handleBlock("", r.domain)}
                        className="rounded p-1 text-red-600 hover:bg-red-50"
                      >
                        <ShieldBan className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState title="No domain data yet" icon={Globe} />
          )}
        </div>
      )}

      {tab === "policies" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-800">URL / Domain Policies</h2>
            <button
              onClick={() => setShowPolicyForm(!showPolicyForm)}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" /> Add Policy
            </button>
          </div>

          {showPolicyForm && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">URL / Domain Pattern</label>
                  <input
                    type="text"
                    placeholder="e.g. medium.com or https://arxiv.org/abs/..."
                    value={policyForm.url_pattern}
                    onChange={(e) => setPolicyForm({ ...policyForm, url_pattern: e.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Policy</label>
                  <select
                    value={policyForm.policy}
                    onChange={(e) => setPolicyForm({ ...policyForm, policy: e.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  >
                    <option value="allow">Allow</option>
                    <option value="vetted">Vetted (boost)</option>
                    <option value="block">Block</option>
                  </select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Reason</label>
                  <input
                    type="text"
                    value={policyForm.reason}
                    onChange={(e) => setPolicyForm({ ...policyForm, reason: e.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Boost Factor</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={policyForm.boost_factor}
                    onChange={(e) => setPolicyForm({ ...policyForm, boost_factor: parseFloat(e.target.value) || 1.0 })}
                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={policyForm.auto_ingest}
                      onChange={(e) => setPolicyForm({ ...policyForm, auto_ingest: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    Auto-ingest to RAG
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowPolicyForm(false)}
                  className="rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreatePolicy}
                  disabled={createPolicy.isPending}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {createPolicy.isPending ? "Saving…" : "Save Policy"}
                </button>
              </div>
            </div>
          )}

          {policyData && policyData.policies.length > 0 ? (
            <DataTable
              keyField="id"
              data={policyData.policies}
              columns={[
                {
                  key: "url_pattern",
                  label: "URL / Domain",
                  render: (r) => (
                    <span className="font-mono text-xs max-w-[300px] truncate block" title={r.url_pattern}>
                      {r.url_pattern}
                    </span>
                  ),
                },
                {
                  key: "policy",
                  label: "Policy",
                  render: (r) => (
                    <StatusBadge
                      status={
                        r.policy === "vetted" ? "approved" :
                        r.policy === "block" ? "rejected" :
                        "pending"
                      }
                      label={r.policy}
                    />
                  ),
                },
                {
                  key: "boost_factor",
                  label: "Boost",
                  render: (r) => <span className="text-xs">{r.boost_factor}×</span>,
                },
                {
                  key: "auto_ingest",
                  label: "Auto-ingest",
                  render: (r) =>
                    r.auto_ingest ? (
                      <StatusBadge status="ok" label="yes" />
                    ) : (
                      <span className="text-xs text-gray-400">no</span>
                    ),
                },
                { key: "reason", label: "Reason" },
                {
                  key: "reviewed_by",
                  label: "By",
                  render: (r) => <span className="text-xs">{r.reviewed_by || "—"}</span>,
                },
                {
                  key: "reviewed_at",
                  label: "When",
                  render: (r) => <span className="text-xs">{fmtTs(r.reviewed_at)}</span>,
                },
                {
                  key: "delete",
                  label: "",
                  render: (r) => (
                    <button
                      title="Delete policy"
                      onClick={() => deletePolicy.mutate(r.id)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState title="No policies configured" icon={ShieldCheck} />
          )}
        </div>
      )}
    </div>
  );
}
