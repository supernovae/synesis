import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCacheMetrics } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { Database, Zap, Target, Trash2, Server, Key, Archive, Clock, Layers } from "lucide-react";

const COLORS = ["#22c55e", "#3b82f6", "#ef4444"];
const PC_COLORS = ["#8b5cf6", "#ef4444"];
const FC_COLORS = ["#f59e0b", "#ef4444"];

export default function CachePerformance() {
  const { data, isLoading } = useCacheMetrics();

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Cache Performance</h1>
          <p className="mt-1 text-sm text-gray-500">Multi-tier cache metrics</p>
        </div>
        <EmptyState title="No cache data" icon={Database} />
      </div>
    );
  }

  const pc = data.prompt_cache;
  const fc = data.frame_cache;
  const redis = data.redis;
  const session = data.session;
  const l2Archive = data.l2_archive;

  const retrievalPie = [
    { name: "Exact Hits", value: data.exact_hits },
    { name: "Semantic Hits", value: data.semantic_hits },
    { name: "Misses", value: data.misses },
  ].filter((d) => d.value > 0);

  const promptPie = pc
    ? [
        { name: "Hits", value: pc.hits },
        { name: "Misses", value: pc.misses },
      ].filter((d) => d.value > 0)
    : [];

  const framePie = fc
    ? [
        { name: "Hits", value: fc.hits },
        { name: "Misses", value: fc.misses },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Cache Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Prompt, frame extraction, and retrieval cache metrics
        </p>
      </div>

      {/* Prompt cache */}
      {pc && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Prompt Cache
            {pc.enabled === false && (
              <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                Disabled
              </span>
            )}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Hit Rate"
              value={`${(pc.hit_rate * 100).toFixed(1)}%`}
              icon={Target}
            />
            <MetricCard label="Hits" value={pc.hits} icon={Zap} />
            <MetricCard label="Misses" value={pc.misses} />
            <MetricCard label="Entries" value={pc.entries} icon={Layers} />
            {pc.max_entries != null && (
              <MetricCard label="Max Entries" value={pc.max_entries} icon={Database} />
            )}
            {pc.ttl_seconds != null && (
              <MetricCard label="TTL" value={`${pc.ttl_seconds}s`} icon={Clock} />
            )}
          </div>
          {promptPie.length > 0 && (
            <div className="mt-4">
              <CachePieChart title="Prompt Cache" data={promptPie} colors={PC_COLORS} />
            </div>
          )}
        </div>
      )}

      {/* Frame cache */}
      {fc && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Frame Extraction Cache
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Hit Rate"
              value={`${(fc.hit_rate * 100).toFixed(1)}%`}
              icon={Target}
            />
            <MetricCard label="Hits" value={fc.hits} icon={Zap} />
            <MetricCard label="Misses" value={fc.misses} />
            <MetricCard label="Entries" value={fc.entries} icon={Layers} />
          </div>
          {framePie.length > 0 && (
            <div className="mt-4">
              <CachePieChart title="Frame Cache" data={framePie} colors={FC_COLORS} />
            </div>
          )}
        </div>
      )}

      {/* Retrieval cache section */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Retrieval Cache
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Hit Rate"
            value={`${(data.hit_rate * 100).toFixed(1)}%`}
            icon={Target}
          />
          <MetricCard label="Exact Hits" value={data.exact_hits} icon={Zap} />
          <MetricCard
            label="Semantic Hits"
            value={data.semantic_hits}
            icon={Database}
          />
          <MetricCard label="Misses" value={data.misses} />
          <MetricCard
            label="Evictions"
            value={data.evictions}
            icon={Trash2}
          />
          <MetricCard label="Entries" value={data.entries} icon={Database} />
        </div>

        {retrievalPie.length > 0 && (
          <div className="mt-4">
            <CachePieChart title="Retrieval Cache" data={retrievalPie} colors={COLORS} />
          </div>
        )}
      </div>

      {/* Redis section */}
      {redis && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Redis
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Status"
              value={
                redis.status === "connected"
                  ? "Connected"
                  : redis.status === "not_configured"
                    ? "Not Configured"
                    : redis.status === "error"
                      ? `Error: ${(redis as { error?: string }).error ?? "unknown"}`
                      : redis.status
              }
              icon={Server}
            />
            {redis.used_memory_human != null && (
              <MetricCard label="Memory" value={redis.used_memory_human} icon={Database} />
            )}
            {redis.keyspace_hit_rate != null && (
              <MetricCard
                label="Keyspace Hit Rate"
                value={`${(redis.keyspace_hit_rate * 100).toFixed(1)}%`}
                icon={Target}
              />
            )}
            {redis.total_keys != null && (
              <MetricCard label="Total Keys" value={redis.total_keys} icon={Key} />
            )}
          </div>
        </div>
      )}

      {/* Session & L2 section */}
      {(session || l2Archive) && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
            Session & L2
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {session && (
              <MetricCard
                label="Session Backend"
                value={session.backend}
                icon={Key}
              />
            )}
            {l2Archive && (
              <MetricCard
                label="L2 Archive"
                value={l2Archive.configured ? "Configured" : "Not Configured"}
                icon={Archive}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CachePieChart({
  title,
  data,
  colors,
}: {
  title: string;
  data: { name: string; value: number }[];
  colors: string[];
}) {
  return (
    <ChartCard title={`${title} Distribution`} subtitle="Hits vs misses">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
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
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
