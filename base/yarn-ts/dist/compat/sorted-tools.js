/**
 * Deterministic JSON serialization for tool schemas. Recursively sorts
 * object keys so identical logical schemas produce identical byte sequences
 * across requests — required for stable prompt-cache prefixes.
 */
export function sortObjectKeys(obj) {
    if (obj === null || obj === undefined)
        return obj;
    if (Array.isArray(obj))
        return obj.map(sortObjectKeys);
    if (typeof obj === "object") {
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortObjectKeys(obj[key]);
        }
        return sorted;
    }
    return obj;
}
/**
 * Normalize a tool definitions array so JSON serialization is deterministic.
 * Returns a new array (does not mutate the input).
 */
export function sortToolSchemas(tools) {
    if (!tools || tools.length === 0)
        return tools;
    return tools.map((t) => sortObjectKeys(t));
}
/**
 * Serialize a value to JSON with sorted keys (shorthand for logging/debug).
 */
export function stableJsonStringify(value) {
    return JSON.stringify(sortObjectKeys(value));
}
