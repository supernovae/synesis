import { useMcpTools } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";

export default function McpTools() {
  const { data, isLoading } = useMcpTools();
  const tools = data?.tools ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">MCP Tools</h1>
        <p className="mt-1 text-sm text-gray-500">
          Model Context Protocol tool registry and usage
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : tools.length === 0 ? (
        <EmptyState title="No MCP tools" description="Tools will appear when the MCP server is reachable" />
      ) : (
        <DataTable
          columns={[
            { key: "name", label: "Tool Name", sortable: true },
            { key: "description", label: "Description" },
            { key: "call_count", label: "Calls", sortable: true, render: (r) => (r.call_count as number | undefined) ?? "---" },
          ]}
          data={tools}
          keyField="name"
        />
      )}
    </div>
  );
}
