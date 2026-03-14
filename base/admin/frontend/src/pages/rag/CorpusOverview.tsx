import { useCorpusStats, useQualitySummary } from "../../api/hooks";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import { Database, FileText, Grid3X3, TrendingUp } from "lucide-react";

const HEALTH_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444"];

export default function CorpusOverview() {
  const { data: corpus, isLoading: corpusLoading } = useCorpusStats();
  const { data: quality } = useQualitySummary();

  const healthData = quality
    ? [
        { name: "Strong", value: quality.strong },
        { name: "Adequate", value: quality.adequate },
        { name: "Weak", value: quality.weak },
        { name: "Empty", value: quality.empty },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Corpus Overview
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Collection statistics and domain health distribution
        </p>
      </div>

      {corpusLoading ? (
        <div className="grid gap-4 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-4">
          <MetricCard
            label="Total Chunks"
            value={corpus?.total_chunks?.toLocaleString() ?? 0}
            icon={Database}
          />
          <MetricCard
            label="Total Documents"
            value={corpus?.total_documents?.toLocaleString() ?? 0}
            icon={FileText}
          />
          <MetricCard
            label="Domains Covered"
            value={corpus?.domains_covered ?? 0}
            icon={Grid3X3}
          />
          <MetricCard
            label="Collection"
            value={corpus?.collection ?? "---"}
            icon={TrendingUp}
          />
        </div>
      )}

      {healthData.length > 0 && (
        <ChartCard title="Domain Health Distribution" subtitle="From latest corpus audit">
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={healthData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={90}
                paddingAngle={3}
                dataKey="value"
                label={({ name, value }) => `${name}: ${value}`}
              >
                {healthData.map((_, i) => (
                  <Cell key={i} fill={HEALTH_COLORS[i % HEALTH_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
