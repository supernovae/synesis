import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCriticStats } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { CheckCircle, XCircle, BarChart3, AlertTriangle } from "lucide-react";

const COLORS = ["#22c55e", "#ef4444"];

export default function CriticAnalytics() {
  const { data, isLoading } = useCriticStats();

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data || data.total_evaluations === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Critic Analytics
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Approval rates, rejection reasons, and scoring
          </p>
        </div>
        <EmptyState
          title="No critic data"
          description="Critic metrics will appear after evaluations run"
        />
      </div>
    );
  }

  const pieData = [
    { name: "Approved", value: Math.round(data.approval_rate * data.total_evaluations) },
    { name: "Rejected", value: Math.round(data.rejection_rate * data.total_evaluations) },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Critic Analytics
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Approval rates, rejection reasons, and scoring
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Evaluations"
          value={data.total_evaluations}
          icon={BarChart3}
        />
        <MetricCard
          label="Approval Rate"
          value={`${(data.approval_rate * 100).toFixed(1)}%`}
          icon={CheckCircle}
        />
        <MetricCard
          label="Avg Score"
          value={data.avg_score.toFixed(2)}
        />
        <MetricCard
          label="Blocking Issues"
          value={data.blocking_issues}
          icon={data.blocking_issues > 0 ? AlertTriangle : XCircle}
        />
      </div>

      {pieData.length > 0 && (
        <ChartCard title="Approval Distribution">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={85}
                paddingAngle={3}
                dataKey="value"
                label={({ name, percent }) =>
                  `${name} ${(percent * 100).toFixed(0)}%`
                }
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
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
