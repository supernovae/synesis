const CORE_TOOL_NAMES = new Set([
    "Read",
    "Write",
    "Edit",
    "Update",
    "Bash",
    "Glob",
    "Grep",
]);
function normalizeName(s) {
    return s.trim().toLowerCase();
}
export function extractToolSchemaName(tool) {
    if (!tool || typeof tool !== "object")
        return "";
    const t = tool;
    const direct = t.name;
    if (typeof direct === "string" && direct.trim())
        return direct.trim();
    const fn = t.function;
    if (fn && typeof fn === "object") {
        const n = fn.name;
        if (typeof n === "string" && n.trim())
            return n.trim();
    }
    return "";
}
function scoreTool(name, recentTools, requestedTools) {
    const norm = normalizeName(name);
    let score = 0;
    if (CORE_TOOL_NAMES.has(name))
        score += 100;
    if (recentTools.has(norm))
        score += 40;
    if (requestedTools.has(norm))
        score += 30;
    return score;
}
export function pruneToolSchemas(tools, maxTools, recentToolNames, requestedToolNames) {
    const list = Array.isArray(tools) ? tools : [];
    if (maxTools <= 0 || list.length <= maxTools) {
        return { tools: list, pruned: false, prunedCount: 0 };
    }
    const recent = new Set(recentToolNames.map(normalizeName));
    const requested = new Set(requestedToolNames.map(normalizeName));
    const ranked = list.map((tool, index) => {
        const name = extractToolSchemaName(tool);
        return {
            index,
            score: scoreTool(name, recent, requested),
        };
    });
    ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const keepIndexes = new Set(ranked.slice(0, maxTools).map((r) => r.index));
    const out = list.filter((_, idx) => keepIndexes.has(idx));
    return {
        tools: out,
        pruned: out.length < list.length,
        prunedCount: Math.max(0, list.length - out.length),
    };
}
