export function enforcePatchFirst(tools) {
    for (const t of tools ?? []) {
        const fn = t?.function;
        if (!fn || typeof fn.name !== "string") {
            continue;
        }
        if (fn.name === "write_file") {
            return "Patch-first policy violation: use apply_patch/search-replace instead of write_file for non-trivial edits.";
        }
    }
    return null;
}
