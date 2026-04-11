import { useState } from "react";
import {
  useTaxonomy,
  useTaxonomyDomain,
  useUpdateTaxonomyDomain,
  useSyncTaxonomyFromYaml,
  useExportTaxonomyYaml,
} from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";
import {
  ChevronRight,
  ChevronDown,
  PenLine,
  RefreshCw,
  Upload,
  Check,
  X,
} from "lucide-react";
import type { TaxonomyDomain } from "../../types";

export default function DomainBrowser() {
  const { data, isLoading } = useTaxonomy();
  const syncMutation = useSyncTaxonomyFromYaml();
  const exportMutation = useExportTaxonomyYaml();
  const domains = data?.domains ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Domain Browser
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Browse and edit {domains.length} taxonomy domains
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            title="Re-import from mounted YAML"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Sync from YAML
          </button>
          <button
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            title="Export DB to YAML for Chat service reload"
          >
            <Upload className="h-3.5 w-3.5" />
            Apply to Chat service
          </button>
        </div>
      </div>

      {syncMutation.isSuccess && (
        <div className="rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          Synced {(syncMutation.data as { synced: number })?.synced} domains
          from YAML.
        </div>
      )}
      {exportMutation.isSuccess && (
        <div className="rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">
          Exported to YAML. Restart the Chat (planner) service to pick up changes.
        </div>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : domains.length === 0 ? (
        <EmptyState title="No taxonomy data" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:divide-gray-800">
          {domains.map((d) => (
            <DomainRow key={d.key} domain={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DomainRow({
  domain,
}: {
  domain: TaxonomyDomain;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [complexity, setComplexity] = useState(domain.complexity);
  const [persona, setPersona] = useState(domain.persona);
  const [depthInstructions, setDepthInstructions] = useState("");
  const [outputStyleGuidance, setOutputStyleGuidance] = useState("");
  const [requiredElements, setRequiredElements] = useState("");
  const mutation = useUpdateTaxonomyDomain();
  const { data: detail } = useTaxonomyDomain(open ? domain.key : "");

  const startEditing = () => {
    if (detail) {
      setDepthInstructions((detail.depth_instructions as string) ?? "");
      setOutputStyleGuidance((detail.output_style_guidance as string) ?? "");
      setRequiredElements(
        Array.isArray(detail.required_elements)
          ? (detail.required_elements as string[]).join("\n")
          : ""
      );
    }
    setEditing(true);
  };

  const handleSave = () => {
    const elements = requiredElements
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    mutation.mutate(
      {
        key: domain.key,
        complexity,
        persona,
        ...(depthInstructions ? { depth_instructions: depthInstructions } : {}),
        ...(outputStyleGuidance ? { output_style_guidance: outputStyleGuidance } : {}),
        ...(elements.length > 0 ? { required_elements: elements } : {}),
      } as Parameters<typeof mutation.mutate>[0],
      { onSuccess: () => setEditing(false) },
    );
  };

  const inputCls =
    "mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white";

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        )}
        <div className="flex-1">
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            {domain.key}
          </span>
          <span className="ml-2 text-xs text-gray-400">{domain.path}</span>
        </div>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          complexity: {domain.complexity}
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 pl-11 dark:border-gray-800 dark:bg-gray-900">
          {editing ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    Complexity
                  </span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={complexity}
                    onChange={(e) => setComplexity(parseFloat(e.target.value) || 0)}
                    className={inputCls}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    Persona
                  </span>
                  <input
                    type="text"
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                    className={inputCls}
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  Required Elements (one per line)
                </span>
                <textarea
                  rows={4}
                  value={requiredElements}
                  onChange={(e) => setRequiredElements(e.target.value)}
                  className={inputCls}
                  placeholder="Design Goals & Constraints&#10;Architecture & Components&#10;..."
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  Depth Instructions
                </span>
                <textarea
                  rows={4}
                  value={depthInstructions}
                  onChange={(e) => setDepthInstructions(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  Output Style Guidance
                </span>
                <textarea
                  rows={4}
                  value={outputStyleGuidance}
                  onChange={(e) => setOutputStyleGuidance(e.target.value)}
                  className={inputCls}
                />
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={mutation.isPending}
                  className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Check className="h-3 w-3" />
                  Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start justify-between">
                <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                  <p><strong>Persona:</strong> {domain.persona || "---"}</p>
                  {detail && (
                    <>
                      {Array.isArray(detail.required_elements) &&
                        (detail.required_elements as string[]).length > 0 && (
                        <div>
                          <strong>Required Elements:</strong>
                          <ul className="ml-4 list-disc text-xs">
                            {(detail.required_elements as string[]).map((el) => (
                              <li key={el}>{el}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {detail.depth_instructions && (
                        <p className="text-xs">
                          <strong>Depth:</strong>{" "}
                          {(detail.depth_instructions as string).slice(0, 200)}...
                        </p>
                      )}
                    </>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditing();
                  }}
                  className="ml-2 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700"
                  title="Edit domain"
                >
                  <PenLine className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
