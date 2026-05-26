import { clsx } from "clsx";
import { AlertTriangle, BrainCircuit, CheckCircle2, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import {
  useYarnModelArchitectureDiagnostics,
  type YarnModelArchitectureDiagnostic,
  type YarnModelArchitectureTrace,
} from "../../api/hooks";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import EmptyState from "../../components/common/EmptyState";
import StatusBadge from "../../components/common/StatusBadge";

function fmtTokens(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

function badgeStatus(value: string | undefined): "strong" | "adequate" | "weak" | "pending" {
  if (value === "strong" || value === "low") return "strong";
  if (value === "medium") return "adequate";
  if (value === "weak" || value === "high") return "weak";
  return "pending";
}

function architectureClass(value: string | undefined): string {
  if (value === "full_attention") return "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-500/30";
  if (value === "sliding_window" || value === "mla") return "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-500/30";
  if (value === "moe" || value === "speculative_friendly" || value === "mtp") return "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-500/30";
  return "bg-gray-50 text-gray-600 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-600/40";
}

function ArchitectureChip({ value }: { value: string | undefined }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", architectureClass(value))}>
      {value || "unknown"}
    </span>
  );
}

function Recommendation({ enabled, label }: { enabled: boolean | undefined; label: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        enabled
          ? "bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-900/30 dark:text-indigo-300 dark:ring-indigo-500/30"
          : "bg-gray-50 text-gray-500 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-600/40",
      )}
    >
      {enabled ? <CheckCircle2 className="h-3 w-3" /> : null}
      {label}
    </span>
  );
}

function ModelPolicyCard({ model }: { model: YarnModelArchitectureDiagnostic }) {
  const arch: YarnModelArchitectureTrace = model.architecture ?? {};
  const reasons = arch.reasons ?? [];
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">{model.model_id}</h2>
            <StatusBadge status={model.resolved ? "healthy" : "warning"} label={model.resolved ? "resolved" : "fallback"} />
            {model.override_applied ? <StatusBadge status="adequate" label="override" /> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <span>
              Backend <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{model.backend_model}</code>
            </span>
            <span>Provider {model.provider || arch.provider || "unknown"}</span>
            <span>Adapter {model.adapter_family}</span>
            {model.tier_id ? <span>Tier {model.tier_id}</span> : null}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[30rem]">
          <Metric label="Declared" value={fmtTokens(arch.declared_context_tokens ?? model.declared_context_tokens)} />
          <Metric label="Effective" value={fmtTokens(arch.effective_context_ceiling_tokens)} />
          <Metric label="Instruction" value={fmtTokens(arch.safe_instruction_tokens)} />
          <Metric label="Tool Output" value={fmtTokens(arch.safe_tool_output_tokens)} />
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Architecture</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <ArchitectureChip value={arch.attention} />
              <ArchitectureChip value={arch.activation} />
              <ArchitectureChip value={arch.decoding} />
              {arch.compaction_mode ? <ArchitectureChip value={`compaction:${arch.compaction_mode}`} /> : null}
              {arch.strict_stream_tool_boundary_validation ? <ArchitectureChip value="strict stream/tool validation" /> : null}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Runtime Policy</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Recommendation enabled={arch.prefer_memory_stitching} label="memory stitching" />
              <Recommendation enabled={arch.prefer_recent_tool_state_replay} label="recent state replay" />
              <Recommendation enabled={arch.prefer_structured_tool_digests} label="structured tool digests" />
              <Recommendation enabled={arch.prefer_explicit_state_headers} label="explicit state headers" />
              <Recommendation enabled={arch.prefer_deterministic_validation} label="deterministic validation" />
            </div>
          </div>

          {model.profile_notes && model.profile_notes.length > 0 ? (
            <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-600 dark:bg-gray-800/70 dark:text-gray-300">
              {model.profile_notes.join(" ")}
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Trait label="Long tail" value={arch.long_tail_retention} />
            <Trait label="Long context" value={arch.long_context_reliability} />
            <Trait label="Tool calls" value={arch.tool_calling_reliability} />
            <Trait label="Compaction" value={arch.compaction_sensitivity} />
            <Trait label="Retry" value={arch.retry_sensitivity} />
            <Trait label="Throughput" value={arch.output_throughput_bias} />
          </div>
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Policy Reasons</h3>
            {reasons.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {reasons.map((reason) => (
                  <span key={reason} className="rounded bg-gray-100 px-2 py-1 font-mono text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {reason}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No special mediation reasons.</p>
            )}
          </div>
          {arch.policy_hash ? (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Policy hash <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{arch.policy_hash}</code>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}

function Trait({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="rounded-md border border-gray-200 p-2 dark:border-gray-700">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1">
        <StatusBadge status={badgeStatus(value)} label={value || "unknown"} />
      </div>
    </div>
  );
}

export default function ModelArchitecture() {
  const { data, isLoading, isFetching, isError, error, refetch } = useYarnModelArchitectureDiagnostics();
  const models = data?.models ?? [];
  const overridden = models.filter((m) => m.override_applied).length;
  const strict = models.filter((m) => m.architecture?.strict_stream_tool_boundary_validation).length;
  const fallback = models.filter((m) => !m.resolved).length;

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="animate-pulse text-gray-500 dark:text-gray-400">Loading architecture policies…</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <ApiErrorBanner error={error} />
        <EmptyState
          icon={AlertTriangle}
          title="Could not load architecture diagnostics"
          description="Verify the Coder runtime is reachable and the internal diagnostics token is configured."
        />
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <EmptyState
        icon={BrainCircuit}
        title="No architecture policies reported"
        description="The Coder runtime did not return configured model architecture diagnostics."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Model Architecture</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Coder runtime mediation policy selected for each model alias.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RefreshCw className={clsx("h-4 w-4", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard icon={BrainCircuit} label="Model aliases" value={models.length.toString()} />
        <SummaryCard icon={ShieldCheck} label="Admin overrides" value={overridden.toString()} />
        <SummaryCard icon={AlertTriangle} label="Fallback profiles" value={fallback.toString()} />
        <SummaryCard icon={CheckCircle2} label="Strict validation" value={strict.toString()} />
      </div>

      <div className="space-y-4">
        {models.map((model) => (
          <ModelPolicyCard key={model.model_id} model={model} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
        <Icon className="h-4 w-4 text-gray-400" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}
