import { useTaxonomy, useQualitySummary } from "../../api/hooks";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";

export default function CoverageMap() {
  const { data: taxData, isLoading: taxLoading } = useTaxonomy();
  const { data: qualityData } = useQualitySummary();

  const domains = taxData?.domains ?? [];
  const scorecards = qualityData?.scorecards ?? [];

  const healthMap = new Map(scorecards.map((sc) => [sc.domain, sc]));

  const groups = new Map<string, typeof domains>();
  for (const d of domains) {
    const root = d.path.split(" > ")[0] || "Other";
    const existing = groups.get(root) || [];
    existing.push(d);
    groups.set(root, existing);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Coverage Map</h1>
        <p className="mt-1 text-sm text-gray-500">
          Audit coverage overlay on taxonomy domains ({domains.length} domains)
        </p>
      </div>

      {taxLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : domains.length === 0 ? (
        <EmptyState title="No taxonomy data" />
      ) : (
        <div className="space-y-4">
          {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => (
            <div key={group} className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-2">
                <h3 className="text-sm font-medium text-gray-900">{group}</h3>
              </div>
              <div className="flex flex-wrap gap-2 p-3">
                {items.map((d) => {
                  const sc = healthMap.get(d.key);
                  const health = sc?.health ?? "empty";
                  return (
                    <div
                      key={d.key}
                      className="flex items-center gap-1.5 rounded-md border border-gray-100 px-2 py-1"
                      title={`${d.key}: ${health}`}
                    >
                      <span className="text-xs text-gray-700">{d.key}</span>
                      <StatusBadge status={health as "strong"} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
