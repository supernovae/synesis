import type { ReducerFamily } from "./types.js";

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export function classifyReducerFamily(toolName?: string, command?: string, raw?: string): ReducerFamily {
  const t = (toolName ?? "").toLowerCase();
  const c = (command ?? "").toLowerCase();
  const tc = `${t} ${c}`;
  const r = (raw ?? "").toLowerCase();

  // Phase 1: high-confidence toolName / command hints (no raw scanning)
  if (hasAny(tc, ["pytest", "py.test"])) return "pytest";
  if (hasAny(tc, ["tsc", "tsc --"])) return "tsc";
  if (hasAny(tc, ["eslint", "ruff"])) return "lint";
  if (hasAny(tc, ["git status", "git diff", "git log", "git show"])) return "git";
  if (hasAny(tc, ["rg ", "rg\t", "ripgrep", "grep "])) return "search";

  // Phase 2: raw content patterns (for generic tool names like "bash", "shell")
  if (hasAny(r, ["=== failures", "failed", "assert "]) && hasAny(r, ["test_", "::test"])) return "pytest";
  if (hasAny(r, ["error ts"]) && hasAny(r, ["): error ts"])) return "tsc";
  if (hasAny(r, ["f401", "e501", "e711", "e722"]) || (hasAny(r, ["warning  ", " error  "]) && hasAny(r, ["eslint", "ruff"]))) return "lint";
  if (hasAny(r, ["on branch", "changes not staged", "changes to be committed"])) return "git";
  // Search: lines matching file:line:content pattern (at least 3 such lines)
  const searchLinePattern = /^[^\s:]+:\d+:/m;
  const searchLineCount = (r.match(/^[^\s:]+:\d+:/gm) ?? []).length;
  if (searchLineCount >= 3) return "search";

  return "generic";
}
