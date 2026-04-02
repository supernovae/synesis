/**
 * Classifier-only policy: what may be stored vs what only invalidates or must bypass.
 * Deterministic; extend with new kinds by updating this map (tests enforce coverage).
 */
const COLLAPSED_KIND_POLICY = {
    batch_read: "read_write_safe",
    batch_search: "read_write_safe",
    repo_context: "read_write_safe",
    merge_patch: "invalidate_generation",
    run_tests: "never",
    passthrough: "never",
};
export function classifyCollapsedKindPolicy(kind) {
    return COLLAPSED_KIND_POLICY[kind] ?? "never";
}
/** Never cache raw patch text or speculative patch blobs from the model. */
export function mayCachePatchPayload() {
    return false;
}
/** Side-effectful or unknown passthrough tools — not cached here. */
export function isPassthroughCacheable() {
    return false;
}
