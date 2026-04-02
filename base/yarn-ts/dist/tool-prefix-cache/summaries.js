/**
 * Deterministic middle-ellipsis truncation for optional summary-tier storage / telemetry.
 * Same input always yields same output (stable prefix suffix for caches that opt in).
 */
export function deterministicTruncateMiddle(text, maxChars) {
    if (maxChars < 80)
        return text.length <= maxChars ? text : `${text.slice(0, maxChars - 20)}…synesis_trunc`;
    if (text.length <= maxChars)
        return text;
    const marker = "\n… synesis_omitted …\n";
    const budget = maxChars - marker.length;
    const head = Math.floor(budget * 0.62);
    const tail = budget - head;
    return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
