import { CheckCircle2, AlertCircle, MinusCircle, Package } from "lucide-react";
import { useYarnLanguagePacks, type LanguagePackConformance } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

function CoverageIndicator({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  let color = "text-red-400";
  let Icon = MinusCircle;
  if (pct >= 80) {
    color = "text-green-400";
    Icon = CheckCircle2;
  } else if (pct >= 50) {
    color = "text-yellow-400";
    Icon = AlertCircle;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${color}`} title={label}>
      <Icon className="w-3.5 h-3.5" />
      {pct}%
    </span>
  );
}

function CountBadge({ count, label }: { count: number; label: string }) {
  const bg = count > 0 ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono ${bg}`}
      title={label}
    >
      {count}
    </span>
  );
}

function PackRow({ pack }: { pack: LanguagePackConformance }) {
  return (
    <tr className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
      <td className="px-4 py-3 font-medium text-zinc-100">{pack.displayName}</td>
      <td className="px-4 py-3 text-xs text-zinc-500 font-mono">{pack.version}</td>
      <td className="px-4 py-3 text-center">
        <CountBadge count={pack.familyCount} label="Validation families" />
      </td>
      <td className="px-4 py-3 text-center">
        <CoverageIndicator
          value={pack.classifierCoverage}
          label={`${pack.classifierCount}/${pack.familyCount} classifiers`}
        />
      </td>
      <td className="px-4 py-3 text-center">
        <CountBadge count={pack.reducerCount} label="Reducers" />
      </td>
      <td className="px-4 py-3 text-center">
        <CountBadge count={pack.fastPathPatternCount} label="Fast-path patterns" />
      </td>
      <td className="px-4 py-3 text-center">
        <CountBadge count={pack.verificationCommandCount} label="Verification commands" />
      </td>
      <td className="px-4 py-3 text-center">
        <CountBadge count={pack.fixRecipeCount} label="Fix recipes" />
      </td>
    </tr>
  );
}

export default function LanguagePacks() {
  const { data, isLoading, error } = useYarnLanguagePacks();
  const packs = data?.languagePacks ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-zinc-400">Loading language packs…</div>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Could not load language packs"
        description="Ensure the Yarn service is running and accessible."
      />
    );
  }

  if (packs.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No language packs registered"
        description="Language packs are loaded when the Yarn service starts."
      />
    );
  }

  const totalFamilies = packs.reduce((s, p) => s + p.familyCount, 0);
  const totalClassifiers = packs.reduce((s, p) => s + p.classifierCount, 0);
  const totalReducers = packs.reduce((s, p) => s + p.reducerCount, 0);
  const totalFastPath = packs.reduce((s, p) => s + p.fastPathPatternCount, 0);
  const totalFixRecipes = packs.reduce((s, p) => s + p.fixRecipeCount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Language Intelligence Packs</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Conformance matrix showing capability coverage per language.
        </p>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3">
          <div className="text-2xl font-bold text-zinc-100">{packs.length}</div>
          <div className="text-xs text-zinc-500">Languages</div>
        </div>
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3">
          <div className="text-2xl font-bold text-zinc-100">{totalFamilies}</div>
          <div className="text-xs text-zinc-500">Families</div>
        </div>
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3">
          <div className="text-2xl font-bold text-zinc-100">{totalClassifiers}</div>
          <div className="text-xs text-zinc-500">Classifiers</div>
        </div>
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3">
          <div className="text-2xl font-bold text-zinc-100">{totalReducers}</div>
          <div className="text-xs text-zinc-500">Reducers</div>
        </div>
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3">
          <div className="text-2xl font-bold text-zinc-100">{totalFastPath}</div>
          <div className="text-xs text-zinc-500">Fast-path patterns</div>
        </div>
      </div>

      <div className="rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-zinc-400 text-xs uppercase border-b border-zinc-800">
              <th className="px-4 py-3 text-left font-medium">Language</th>
              <th className="px-4 py-3 text-left font-medium">Version</th>
              <th className="px-4 py-3 text-center font-medium">Families</th>
              <th className="px-4 py-3 text-center font-medium">Classifiers</th>
              <th className="px-4 py-3 text-center font-medium">Reducers</th>
              <th className="px-4 py-3 text-center font-medium">Fast-Path</th>
              <th className="px-4 py-3 text-center font-medium">Verify Cmds</th>
              <th className="px-4 py-3 text-center font-medium">Fix Recipes</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <PackRow key={pack.language} pack={pack} />
            ))}
          </tbody>
          <tfoot>
            <tr className="text-zinc-400 text-xs border-t border-zinc-700 font-medium">
              <td className="px-4 py-2">Total</td>
              <td className="px-4 py-2" />
              <td className="px-4 py-2 text-center">{totalFamilies}</td>
              <td className="px-4 py-2 text-center">{totalClassifiers}</td>
              <td className="px-4 py-2 text-center">{totalReducers}</td>
              <td className="px-4 py-2 text-center">{totalFastPath}</td>
              <td className="px-4 py-2 text-center">
                {packs.reduce((s, p) => s + p.verificationCommandCount, 0)}
              </td>
              <td className="px-4 py-2 text-center">{totalFixRecipes}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
