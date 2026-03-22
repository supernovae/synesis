import { useMcpTools, useMcpAgentHealth, useMcpAdminCatalog } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import { CheckCircle2, XCircle, Server, Shield } from "lucide-react";

export default function McpTools() {
  const { data, isLoading } = useMcpTools();
  const { data: health, isLoading: healthLoading } = useMcpAgentHealth();
  const { data: adminCat, isLoading: adminLoading } = useMcpAdminCatalog();
  const tools = data?.tools ?? [];
  const adminTools = adminCat?.tools ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">MCP integrations</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Two surfaces: <strong>Agent MCP</strong> (synesis-mcp for Yarn / IDE) and{" "}
          <strong>Admin MCP</strong> (HTTP tools with the same JWT/PAT and RBAC as the REST API).
        </p>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Server className="h-5 w-5 text-indigo-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Agent MCP (synesis-mcp)</h2>
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
          Used by Yarn and coding agents. Service URL is configured as <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">SYNESIS_MCP_URL</code> (cluster port <strong>8100</strong>).
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
            description="synesis-mcp did not return tools — check deployment, network policy, and SYNESIS_MCP_URL (port 8100)."
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
        <div className="mb-4 flex items-center gap-3">
          <Shield className="h-5 w-5 text-violet-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Admin MCP (HTTP)</h2>
        </div>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          List tools: <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">GET /api/v1/mcp/tools</code> with{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">Authorization: Bearer &lt;token&gt;</code>.
          Execute: <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">POST /api/v1/mcp/tools/call</code> with{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{"{ \"name\": \"...\", \"arguments\": {} }"}</code>.
          Calls are RBAC-filtered and audited.
        </p>
        {adminCat?.scope === "visible" && adminCat.note && (
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{adminCat.note}</p>
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
