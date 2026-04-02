/**
 * Strip or pass through `defer_loading` and `tool_reference` blocks
 * on outbound tool definitions. Default mode is "disable" because most
 * OpenAI-compatible upstreams do not support Anthropic tool search.
 */
export function applyToolSearchPolicy(tools, mode = "disable") {
    if (!tools || tools.length === 0) {
        return { tools, strippedDeferredCount: 0 };
    }
    if (mode === "passthrough") {
        return { tools, strippedDeferredCount: 0 };
    }
    let strippedDeferredCount = 0;
    const cleaned = tools.map((tool) => {
        const out = { ...tool };
        if (out.defer_loading) {
            delete out.defer_loading;
            strippedDeferredCount++;
        }
        stripToolReferences(out);
        return out;
    });
    return { tools: cleaned, strippedDeferredCount };
}
function stripToolReferences(tool) {
    const content = tool.content;
    if (Array.isArray(content)) {
        tool.content = content.filter((b) => !(typeof b === "object" && b !== null && b.type === "tool_reference"));
    }
}
