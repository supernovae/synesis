import { useMcpTools, useMcpAgentHealth, useMcpAdminCatalog, useMcpAdminMcpHealth } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import { CheckCircle2, XCircle, Server, Shield } from "lucide-react";

export default function McpTools() {
  const { data, isLoading } = useMcpTools();
  const { data: health, isLoading: healthLoading } = useMcpAgentHealth();
  const { data: adminMcpHealth, isLoading: adminMcpHealthLoading } = useMcpAdminMcpHealth();
  const { data: adminCat, isLoading: adminLoading } = useMcpAdminCatalog();
  const tools = data?.tools ?? [];
  const adminTools = adminCat?.tools ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">MCP integrations</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Two services: <strong>synesis-mcp-ts</strong> (Coder API agent tools — Streamable HTTP, PAT + FGA) and{" "}
          <strong>synesis-admin-mcp-ts</strong> (Admin console tools — internal Streamable HTTP mediated by the Admin
          API).
        </p>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Server className="h-5 w-5 text-indigo-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Agent MCP (synesis-mcp-ts)</h2>
          {healthLoading ? (
            <span className="text-sm text-gray-400">Checking…</span>
          ) : health?.reachable ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> Reachable
              {health.latency_ms != null && ` · ${health.latency_ms}ms`}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
              <XCircle className="h-3.5 w-3.5" /> Unreachable
            </span>
          )}
        </div>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Official MCP Streamable HTTP endpoint. Probe URL comes from <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">SYNESIS_MCP_URL</code> (cluster port <strong>8100</strong>). Tool catalog is exposed at{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">GET /v1/synesis-tools</code> (metadata only); protocol traffic uses the configured <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">SYNESIS_MCP_HTTP_PATH</code> (default{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">/mcp</code>).
        </p>
        {!health?.reachable && health?.error && (
          <p className="mb-4 rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            {health.error}
          </p>
        )}
        {isLoading ? (
          <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
        ) : tools.length === 0 ? (
          <EmptyState
            title="No agent MCP tools"
            description="Could not load catalog from synesis-mcp-ts — check SYNESIS_MCP_URL, network policy, and that GET /v1/synesis-tools is reachable."
          />
        ) : (
          <DataTable
            columns={[
              { key: "name", label: "Tool", sortable: true },
              { key: "description", label: "Description" },
            ]}
            data={tools}
            keyField="name"
          />
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Shield className="h-5 w-5 text-violet-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Admin MCP (synesis-admin-mcp-ts)</h2>
          {adminMcpHealthLoading ? (
            <span className="text-sm text-gray-400">Checking…</span>
          ) : adminMcpHealth?.reachable ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> Reachable
              {adminMcpHealth.latency_ms != null && ` · ${adminMcpHealth.latency_ms}ms`}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
              <XCircle className="h-3.5 w-3.5" /> Unreachable
            </span>
          )}
        </div>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Internal MCP Streamable HTTP for the Admin Assistant. Probe URL: <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">SYNESIS_ADMIN_MCP_URL</code> (port <strong>8102</strong>). The Admin API mediates access with an internal service token and a delegated admin session. The server validates the session against{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">GET /api/v1/auth/me</code>, serves its TS-owned catalog at{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">GET /v1/admin-tools</code>, and executes via{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">POST /v1/admin-tools/invoke</code> (audited in admin).
        </p>
        {!adminMcpHealth?.reachable && adminMcpHealth?.error && (
          <p className="mb-4 rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            {adminMcpHealth.error}
          </p>
        )}
        {adminLoading ? (
          <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
        ) : adminTools.length === 0 ? (
          <EmptyState title="No admin tools" description="Unexpected empty catalog" />
        ) : (
          <DataTable
            columns={[
              { key: "name", label: "Tool", sortable: true },
              { key: "description", label: "Description" },
              {
                key: "min_role",
                label: "Min role",
                render: (r: { min_role?: string }) => (r.min_role as string) ?? "—",
              },
            ]}
            data={adminTools}
            keyField="name"
          />
        )}
      </section>
    </div>
  );
}
