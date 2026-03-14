import { Link } from "react-router-dom";
import { useQualitySummary } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

export default function QualityDashboard() {
  const { data, isLoading } = useQualitySummary();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Quality Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Corpus audit scorecards by domain
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : !data ? (
        <EmptyState title="No quality data" description="Run corpus audit to generate quality report" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Strong" value={data.strong} />
            <MetricCard label="Adequate" value={data.adequate} />
            <MetricCard label="Weak" value={data.weak} />
            <MetricCard label="Empty" value={data.empty} />
          </div>

          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Domain</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Path</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Health</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Chunks</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Hit Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {data.scorecards?.map((sc) => (
                  <tr key={sc.domain} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm">
                      <Link to={`/rag/quality/${sc.domain}`} className="font-medium text-blue-600 hover:text-blue-800">
                        {sc.domain}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{sc.path}</td>
                    <td className="px-4 py-3 text-sm"><StatusBadge status={sc.health} /></td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700">{sc.inventory?.total_chunks ?? 0}</td>
                    <td className="px-4 py-3 text-right text-sm text-gray-700">{((sc.coverage?.hit_rate ?? 0) * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
