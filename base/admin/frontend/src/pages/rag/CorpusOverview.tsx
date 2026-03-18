import { useState } from "react";
import { useCorpusStats, useQualitySummary } from "../../api/hooks";
import { useQuery } from "@tanstack/react-query";
import client from "../../api/client";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import { Database, FileText, Grid3X3, Layers, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";

interface SchemaField {
  name: string;
  type: string;
  is_primary: boolean;
  max_length?: number;
  dim?: number;
}

interface SchemaIndex {
  name: string;
  field: string;
  type: string;
  metric: string;
}

interface DomainHierarchy {
  domain: string;
  total_chunks: number;
  sources: Array<{ source: string; chunks: number }>;
}

interface CorpusSchemaData {
  collection: string;
  schema: { exists: boolean; fields?: SchemaField[]; indexes?: SchemaIndex[] };
  hierarchy: DomainHierarchy[];
}

function useCorpusSchema() {
  return useQuery<CorpusSchemaData>({
    queryKey: ["rag", "corpus", "schema"],
    queryFn: () => client.get("/rag/corpus/schema").then((r) => r.data),
    staleTime: 120_000,
  });
}

const HEALTH_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444"];

export default function CorpusOverview() {
  const { data: corpus, isLoading: corpusLoading } = useCorpusStats();
  const { data: quality } = useQualitySummary();
  const { data: schemaData } = useCorpusSchema();
  const [tab, setTab] = useState<"overview" | "schema">("overview");

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
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Corpus Overview
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Collection statistics and domain health distribution
        </p>
      </div>

      {corpusLoading ? (
        <div className="grid gap-4 sm:grid-cols-5">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-5">
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
            label="Sources"
            value={corpus?.total_sources ?? 0}
            icon={FolderOpen}
          />
          <MetricCard
            label="Domains"
            value={corpus?.domains_covered ?? 0}
            icon={Grid3X3}
          />
          <MetricCard
            label="Schema"
            value={`v${corpus?.schema_version ?? "?"}`}
            icon={Layers}
          />
        </div>
      )}

      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {(["overview", "schema"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {t === "overview" ? "Overview" : "Schema & Hierarchy"}
          </button>
        ))}
      </div>

      {tab === "overview" && healthData.length > 0 && (
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

      {tab === "schema" && schemaData && (
        <SchemaView data={schemaData} />
      )}
    </div>
  );
}

function SchemaView({ data }: { data: CorpusSchemaData }) {
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  const schema = data.schema;
  const hierarchy = data.hierarchy;

  return (
    <div className="space-y-6">
      {schema.fields && schema.fields.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Collection Fields
          </h3>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Type</th>
                  <th className="px-4 py-2 text-center text-xs font-medium uppercase text-gray-500">Primary</th>
                  <th className="px-4 py-2 text-center text-xs font-medium uppercase text-gray-500">Max Length / Dim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {schema.fields.map((f) => (
                  <tr key={f.name}>
                    <td className="px-4 py-1.5 font-mono text-sm text-gray-800 dark:text-gray-200">{f.name}</td>
                    <td className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400">{f.type}</td>
                    <td className="px-4 py-1.5 text-center text-sm">{f.is_primary ? "✓" : ""}</td>
                    <td className="px-4 py-1.5 text-center text-sm text-gray-500">{f.max_length ?? f.dim ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {schema.indexes && schema.indexes.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Indexes
          </h3>
          <div className="flex flex-wrap gap-3">
            {schema.indexes.map((idx) => (
              <div
                key={idx.name}
                className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-800"
              >
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{idx.name}</p>
                <p className="text-xs text-gray-500">
                  {idx.field} · {idx.type} · {idx.metric}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {hierarchy.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            Domain → Source Hierarchy
          </h3>
          <div className="space-y-1">
            {hierarchy.map((h) => (
              <div key={h.domain}>
                <button
                  onClick={() =>
                    setExpandedDomain(expandedDomain === h.domain ? null : h.domain)
                  }
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {expandedDomain === h.domain ? (
                    <ChevronDown className="h-4 w-4 text-gray-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  )}
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {h.domain}
                  </span>
                  <span className="ml-auto rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                    {h.total_chunks.toLocaleString()} chunks
                  </span>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700">
                    {h.sources.length} sources
                  </span>
                </button>
                {expandedDomain === h.domain && (
                  <div className="ml-6 mb-2 space-y-0.5">
                    {h.sources.map((s) => (
                      <div
                        key={s.source}
                        className="flex items-center justify-between rounded px-3 py-1 text-sm text-gray-600 dark:text-gray-400"
                      >
                        <span className="truncate">{s.source}</span>
                        <span className="ml-2 text-xs text-gray-400">{s.chunks} chunks</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
