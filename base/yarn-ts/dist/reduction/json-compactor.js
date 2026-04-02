const SIGNAL_KEYS = ["error", "err", "warning", "warn", "status", "score", "level", "severity"];
const ANOMALY_VALUES = ["error", "fail", "failure", "critical", "exception", "timeout", "denied"];
function isJsonArray(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("["))
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed))
            return null;
        if (parsed.length < 3)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function itemFingerprint(item) {
    if (typeof item !== "object" || item === null)
        return typeof item;
    return Object.keys(item).sort().join(",");
}
function isHomogeneous(items) {
    if (items.length < 3)
        return false;
    const first = itemFingerprint(items[0]);
    let matchCount = 0;
    for (let i = 1; i < Math.min(items.length, 10); i++) {
        if (itemFingerprint(items[i]) === first)
            matchCount++;
    }
    return matchCount / Math.min(items.length - 1, 9) >= 0.7;
}
function hasSignalField(item) {
    if (typeof item !== "object" || item === null)
        return false;
    const keys = Object.keys(item);
    return keys.some((k) => SIGNAL_KEYS.includes(k.toLowerCase()));
}
function isAnomalyItem(item) {
    const str = JSON.stringify(item).toLowerCase();
    return ANOMALY_VALUES.some((v) => str.includes(v));
}
function elbowBudget(n) {
    if (n <= 5)
        return n;
    if (n <= 20)
        return Math.ceil(n * 0.5);
    if (n <= 100)
        return Math.min(15, Math.ceil(n * 0.3));
    return Math.min(20, Math.ceil(Math.sqrt(n) * 2));
}
function selectItems(items, budget) {
    if (items.length <= budget) {
        return { selected: items, indices: items.map((_, i) => i) };
    }
    const indexSet = new Set();
    indexSet.add(0);
    indexSet.add(1);
    indexSet.add(items.length - 2);
    indexSet.add(items.length - 1);
    for (let i = 0; i < items.length && indexSet.size < budget; i++) {
        if (isAnomalyItem(items[i]))
            indexSet.add(i);
    }
    const middleStart = 2;
    const middleEnd = items.length - 2;
    if (middleEnd > middleStart) {
        const stride = Math.max(1, Math.floor((middleEnd - middleStart) / (budget - indexSet.size + 1)));
        for (let i = middleStart; i < middleEnd && indexSet.size < budget; i += stride) {
            indexSet.add(i);
        }
    }
    const indices = [...indexSet].sort((a, b) => a - b);
    return { selected: indices.map((i) => items[i]), indices };
}
export function compactJsonArray(raw, opts = {}) {
    const items = isJsonArray(raw);
    if (!items)
        return null;
    if (!isHomogeneous(items))
        return null;
    if (!hasSignalField(items[0])) {
        const avgItemLen = raw.length / items.length;
        if (avgItemLen > 2000)
            return null;
    }
    const budget = opts.maxOutputItems ?? elbowBudget(items.length);
    const { selected, indices } = selectItems(items, budget);
    const compactedJson = JSON.stringify(selected, null, 2);
    const header = [
        `<JSON_COMPACTED items="${items.length}" shown="${selected.length}" indices="[${indices.join(",")}]">`,
        `Omitted ${items.length - selected.length} structurally similar items.`,
        opts.artifactHandle ? `Full data: artifact_handle=${opts.artifactHandle}` : "",
        "Showing boundary items, anomalies, and evenly-sampled middle."
    ]
        .filter(Boolean)
        .join("\n");
    const compacted = `${header}\n${compactedJson}\n</JSON_COMPACTED>`;
    return {
        compacted,
        originalItems: items.length,
        keptItems: selected.length,
        compressionRatio: raw.length > 0 ? 1 - compacted.length / raw.length : 0
    };
}
