import { CheckCircle2, AlertCircle, MinusCircle, Package } from "lucide-react";
import { useYarnLanguagePacks, type LanguagePackConformance } from "../../api/hooks";
import EmptyState from "../../components/common/EmptyState";

function CoverageIndicator({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  let color = "text-red-600 dark:text-red-400";
  let Icon = MinusCircle;
  if (pct >= 80) {
    color = "text-green-600 dark:text-green-400";
    Icon = CheckCircle2;
  } else if (pct >= 50) {
    color = "text-amber-600 dark:text-amber-400";
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
  const bg = count > 0
    ? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
    : "bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-500";
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
    <tr className="border-b border-gray-200 transition-colors hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50">
      <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{pack.displayName}</td>
      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{pack.version}</td>
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
        <div className="animate-pulse text-gray-500 dark:text-gray-400">Loading language packs…</div>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Could not load language packs"
        description="Ensure the Coder runtime is running and accessible."
      />
    );
  }

  if (packs.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No language packs registered"
        description="Language packs are loaded when the Coder runtime starts."
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
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Language Intelligence Packs</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Coder runtime — conformance matrix showing capability coverage per language.
        </p>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{packs.length}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Languages</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalFamilies}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Families</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalClassifiers}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Classifiers</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalReducers}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Reducers</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalFastPath}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Fast-path patterns</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500 dark:border-gray-800 dark:text-gray-400">
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
            <tr className="border-t border-gray-200 text-xs font-medium text-gray-600 dark:border-gray-700 dark:text-gray-400">
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
