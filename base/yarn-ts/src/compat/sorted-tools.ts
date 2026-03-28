/**
 * Deterministic JSON serialization for tool schemas. Recursively sorts
 * object keys so identical logical schemas produce identical byte sequences
 * across requests — required for stable prompt-cache prefixes.
 */

export function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/**
 * Normalize a tool definitions array so JSON serialization is deterministic.
 * Returns a new array (does not mutate the input).
 */
export function sortToolSchemas<T>(tools: T[] | undefined): T[] | undefined {
  if (!tools || tools.length === 0) return tools;
  return tools.map((t) => sortObjectKeys(t) as T);
}

/**
 * Serialize a value to JSON with sorted keys (shorthand for logging/debug).
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}
