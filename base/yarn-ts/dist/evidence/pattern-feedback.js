/**
 * Fire-and-forget pattern usage feedback to admin service.
 * Reports when a pattern recall was used and whether verification passed.
 */
let _adminUrl = "";
let _serviceToken = "";
let _enabled = false;
const _stats = { sent: 0, errors: 0 };
export function initPatternFeedback(config) {
    _adminUrl = config.SYNESIS_YARN_ADMIN_API_URL.replace(/\/+$/, "");
    _serviceToken = config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "";
    _enabled = config.SYNESIS_YARN_PATTERN_USAGE_FEEDBACK_ENABLED;
}
export function getPatternFeedbackStats() {
    return { ..._stats, enabled: _enabled };
}
export function reportPatternUsage(patternId, outcome) {
    if (!_enabled || !_adminUrl)
        return;
    const headers = { "Content-Type": "application/json" };
    if (_serviceToken) {
        headers["Authorization"] = `Bearer ${_serviceToken}`;
    }
    fetch(`${_adminUrl}/api/v1/patterns/${encodeURIComponent(patternId)}/usage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ outcome }),
        signal: AbortSignal.timeout(5000),
    })
        .then(() => { _stats.sent++; })
        .catch(() => { _stats.errors++; });
}
