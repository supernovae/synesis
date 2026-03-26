import type { ReducerFamily } from "./types.js";

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export function classifyReducerFamily(toolName?: string, command?: string, raw?: string): ReducerFamily {
  const t = (toolName ?? "").toLowerCase();
  const c = (command ?? "").toLowerCase();
  const r = (raw ?? "").toLowerCase();
  const all = `${t} ${c} ${r}`;

  if (hasAny(all, ["pytest", "failed", "assert ", "=== failures"])) return "pytest";
  if (hasAny(`${t} ${c}`, ["tsc", "tsc --"])) return "tsc";
  if (hasAny(r, ["error ts"])) return "tsc";
  if (hasAny(all, ["eslint", "ruff", "f401", "e501", "warning  ", " error  "])) return "lint";
  if (hasAny(all, ["git status", "git diff", "git log", "on branch", "changes not staged"])) return "git";
  if (hasAny(all, ["rg ", "ripgrep", "grep ", "match", ":"])) return "search";
  return "generic";
}
