/** Optional `x-synesis-orchestrator-phase` / `auto` — overrides frame-derived phase for tier routing. */
export function parseOrchestratorPhaseHeader(value) {
    const v = (value ?? "").trim().toLowerCase();
    if (!v || v === "auto")
        return undefined;
    if (v === "planning" || v === "implementation" || v === "validation" || v === "explore") {
        return v;
    }
    return undefined;
}
