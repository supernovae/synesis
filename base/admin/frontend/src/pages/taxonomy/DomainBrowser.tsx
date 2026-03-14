import { useState } from "react";
import { useTaxonomy } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";
import { ChevronRight, ChevronDown } from "lucide-react";

export default function DomainBrowser() {
  const { data, isLoading } = useTaxonomy();
  const domains = data?.domains ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Domain Browser</h1>
        <p className="mt-1 text-sm text-gray-500">
          Browse {domains.length} taxonomy domains
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : domains.length === 0 ? (
        <EmptyState title="No taxonomy data" />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
          {domains.map((d) => (
            <DomainRow key={d.key} domain={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DomainRow({ domain }: { domain: { key: string; path: string; complexity: number; persona: string } }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <div className="flex-1">
          <span className="text-sm font-medium text-gray-900">{domain.key}</span>
          <span className="ml-2 text-xs text-gray-400">{domain.path}</span>
        </div>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
          complexity: {domain.complexity}
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 pl-11 text-sm text-gray-600">
          <p><strong>Persona:</strong> {domain.persona}</p>
        </div>
      )}
    </div>
  );
}
