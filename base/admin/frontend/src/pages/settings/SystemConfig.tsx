import { useSystemConfig } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

export default function SystemConfig() {
  const { data, isLoading } = useSystemConfig();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Read-only view of system configuration
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : !data ? (
        <EmptyState title="No configuration data" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Key</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {Object.entries(data.config ?? {}).map(([k, v]) => (
                <tr key={k}>
                  <td className="px-4 py-2 text-sm font-mono text-gray-700">{k}</td>
                  <td className="px-4 py-2 text-sm text-gray-600">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
