/**
 * Attention-Aware Context Positioning
 *
 * Based on Liu et al. 2023 "Lost in the Middle: How Language Models Use Long Contexts"
 * (https://arxiv.org/abs/2307.03172)
 *
 * LLMs attend strongly to the beginning and end of context (U-curve), but poorly
 * to the middle. This service reorders system/context blocks to place high-value
 * content at the edges and bulk/low-priority content in the middle.
 */
function isSystemBlock(content) {
    const str = typeof content === "string" ? content : "";
    return (str.includes("<WORKING_FRAME>") ||
        str.includes("<PROJECT_MANIFEST>") ||
        str.includes("<CLIENT_ADAPTER>") ||
        str.includes("<ARCHITECTURAL_STATE>") ||
        str.includes("<SESSION_CONTINUITY>") ||
        str.includes("<RESPONSE_STYLE>"));
}
function classifyBlock(content) {
    if (content.includes("<ARCHITECTURAL_STATE>")) {
        return { role: "system", content, priority: "high", placement: "begin" };
    }
    if (content.includes("<SESSION_CONTINUITY>")) {
        return { role: "system", content, priority: "high", placement: "begin" };
    }
    if (content.includes("<WORKING_FRAME>")) {
        return { role: "system", content, priority: "medium", placement: "begin" };
    }
    if (content.includes("<PROJECT_MANIFEST>")) {
        return { role: "system", content, priority: "low", placement: "any" };
    }
    if (content.includes("<CLIENT_ADAPTER>")) {
        return { role: "system", content, priority: "medium", placement: "begin" };
    }
    if (content.includes("<RESPONSE_STYLE>")) {
        return { role: "system", content, priority: "medium", placement: "begin" };
    }
    return { role: "system", content, priority: "medium", placement: "any" };
}
export class AttentionPositioningService {
    stats = {
        positionedCount: 0,
        beginBlocksPlaced: 0,
        endBlocksPlaced: 0
    };
    /**
     * Reorder messages so high-value system blocks sit at the beginning or end
     * of the context window. Non-system messages (user, assistant, tool) keep
     * their original chronological order in the middle.
     */
    position(messages) {
        const systemBlocks = [];
        const conversationMessages = [];
        for (const m of messages) {
            const content = typeof m.content === "string" ? m.content : "";
            if (m.role === "system" && isSystemBlock(m.content)) {
                systemBlocks.push(classifyBlock(content));
            }
            else {
                conversationMessages.push(m);
            }
        }
        if (systemBlocks.length === 0) {
            return { messages, beginBlockCount: 0, endBlockCount: 0 };
        }
        const beginBlocks = systemBlocks.filter((b) => b.placement === "begin");
        const endBlocks = systemBlocks.filter((b) => b.placement === "end");
        const anyBlocks = systemBlocks.filter((b) => b.placement === "any");
        beginBlocks.sort((a, b) => (a.priority === "high" ? -1 : 0) - (b.priority === "high" ? -1 : 0));
        endBlocks.sort((a, b) => (a.priority === "high" ? -1 : 0) - (b.priority === "high" ? -1 : 0));
        const result = [];
        for (const b of beginBlocks)
            result.push({ role: "system", content: b.content });
        for (const b of anyBlocks)
            result.push({ role: "system", content: b.content });
        for (const m of conversationMessages)
            result.push(m);
        for (const b of endBlocks)
            result.push({ role: "system", content: b.content });
        this.stats.positionedCount++;
        this.stats.beginBlocksPlaced += beginBlocks.length + anyBlocks.length;
        this.stats.endBlocksPlaced += endBlocks.length;
        return {
            messages: result,
            beginBlockCount: beginBlocks.length + anyBlocks.length,
            endBlockCount: endBlocks.length
        };
    }
    getStats() {
        return { ...this.stats };
    }
}
