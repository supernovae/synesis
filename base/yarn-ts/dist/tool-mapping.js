import { jsonSchema } from "ai";
let synthCounter = 0;
/**
 * Repair malformed tool_calls in conversation history so strict providers
 * (e.g. DeepInfra) don't reject the request with 422.
 *
 * Fixes: empty tool-call IDs, missing function.arguments, and propagates
 * synthetic IDs to the matching tool-result messages that follow.
 */
export function sanitizeToolCalls(messages) {
    const out = [];
    const pendingEmptyIdQueue = [];
    for (const m of messages) {
        if (m.role === "assistant" && m.tool_calls?.length) {
            let changed = false;
            const fixedCalls = m.tool_calls.map((tc) => {
                let id = tc.id;
                if (!id) {
                    id = `call_synth_${++synthCounter}_${Date.now().toString(36)}`;
                    pendingEmptyIdQueue.push(id);
                    changed = true;
                }
                const fn = tc.function;
                const args = fn?.arguments ?? "{}";
                const name = fn?.name ?? "";
                if (!fn || fn.arguments === undefined)
                    changed = true;
                return {
                    id,
                    type: tc.type ?? "function",
                    function: { name, arguments: args },
                };
            });
            out.push(changed ? { ...m, tool_calls: fixedCalls } : m);
            continue;
        }
        if (m.role === "tool" && !m.tool_call_id && pendingEmptyIdQueue.length > 0) {
            out.push({ ...m, tool_call_id: pendingEmptyIdQueue.shift() });
            continue;
        }
        out.push(m);
    }
    return out;
}
/**
 * Convert raw OpenAI chat-format messages into the Vercel AI SDK ModelMessage
 * format that generateText / streamText accept directly.
 *
 * This replaces convertToModelMessages (which expects the SDK's own UI format
 * with `.parts` arrays and crashes on raw OpenAI payloads).
 */
export function openAIMessagesToModelMessages(messages) {
    const out = [];
    for (const m of messages) {
        switch (m.role) {
            case "system":
                out.push({ role: "system", content: String(m.content ?? "") });
                break;
            case "user":
                out.push({ role: "user", content: String(m.content ?? "") });
                break;
            case "assistant": {
                const parts = [];
                const text = typeof m.content === "string" ? m.content : "";
                if (text)
                    parts.push({ type: "text", text });
                if (m.tool_calls) {
                    for (const tc of m.tool_calls) {
                        let parsedInput = {};
                        try {
                            parsedInput = JSON.parse(tc.function?.arguments ?? "{}");
                        }
                        catch { /* keep {} */ }
                        parts.push({
                            type: "tool-call",
                            toolCallId: tc.id,
                            toolName: tc.function?.name ?? "",
                            input: parsedInput
                        });
                    }
                }
                if (parts.length === 0)
                    parts.push({ type: "text", text: "" });
                out.push({ role: "assistant", content: parts });
                break;
            }
            case "tool": {
                const resultContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                out.push({
                    role: "tool",
                    content: [{
                            type: "tool-result",
                            toolCallId: m.tool_call_id ?? "",
                            toolName: m.name ?? "",
                            output: { type: "text", value: resultContent }
                        }]
                });
                break;
            }
            default:
                out.push({ role: "user", content: String(m.content ?? "") });
        }
    }
    return out;
}
export function openAIToolsToSDK(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    const out = {};
    for (const t of tools) {
        const fn = t.function;
        if (!fn?.name)
            continue;
        out[fn.name] = {
            description: fn.description ?? "",
            inputSchema: jsonSchema(fn.parameters ?? { type: "object", properties: {} })
        };
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
export function claudeToolsToSDK(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    const out = {};
    for (const t of tools) {
        if (!t.name)
            continue;
        out[t.name] = {
            description: t.description ?? "",
            inputSchema: jsonSchema(t.input_schema ?? { type: "object", properties: {} })
        };
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
export function mapToolChoice(choice) {
    if (choice === undefined || choice === null)
        return undefined;
    if (typeof choice === "string") {
        if (choice === "auto" || choice === "none" || choice === "required")
            return choice;
        if (choice === "any")
            return "required";
        return "auto";
    }
    if (typeof choice === "object") {
        const obj = choice;
        if (obj.type === "tool" && typeof obj.name === "string") {
            return { type: "tool", toolName: obj.name };
        }
        if (obj.type === "function" && typeof obj.function?.name === "string") {
            return { type: "tool", toolName: obj.function.name };
        }
        if (obj.type === "auto")
            return "auto";
        if (obj.type === "none")
            return "none";
        if (obj.type === "any" || obj.type === "required")
            return "required";
    }
    return "auto";
}
export function sdkToolCallsToOpenAI(toolCalls) {
    return toolCalls.map((tc) => ({
        id: tc.toolCallId,
        type: "function",
        function: {
            name: tc.toolName,
            arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input)
        }
    }));
}
export function sdkToolCallsToClaude(toolCalls) {
    return toolCalls.map((tc) => ({
        type: "tool_use",
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.input
    }));
}
export function claudeMessagesToOpenAI(messages, reduceToolResult) {
    const out = [];
    for (const m of messages) {
        if (typeof m.content === "string") {
            out.push({ role: m.role, content: m.content });
            continue;
        }
        if (!Array.isArray(m.content)) {
            out.push({ role: m.role, content: JSON.stringify(m.content) });
            continue;
        }
        const textParts = [];
        const toolUseParts = [];
        const toolResultParts = [];
        for (const block of m.content) {
            if (block.type === "text" && block.text) {
                textParts.push(block.text);
            }
            else if (block.type === "tool_use") {
                toolUseParts.push(block);
            }
            else if (block.type === "tool_result") {
                toolResultParts.push(block);
            }
            else {
                textParts.push(JSON.stringify(block));
            }
        }
        if (textParts.length > 0 || toolUseParts.length > 0) {
            const combined = textParts.join("\n");
            if (toolUseParts.length > 0) {
                const toolCalls = toolUseParts.map((tu) => ({
                    id: tu.id ?? "",
                    type: "function",
                    function: {
                        name: tu.name ?? "",
                        arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {})
                    }
                }));
                out.push({
                    role: "assistant",
                    content: combined || undefined,
                    tool_calls: toolCalls
                });
            }
            else {
                out.push({ role: m.role, content: combined });
            }
        }
        for (const tr of toolResultParts) {
            const baseResultContent = typeof tr.content === "string"
                ? tr.content
                : JSON.stringify(tr.content ?? "");
            const resultContent = reduceToolResult
                ? reduceToolResult(baseResultContent, tr.name)
                : baseResultContent;
            out.push({
                role: "tool",
                content: resultContent,
                tool_call_id: tr.tool_use_id ?? "",
                name: tr.name
            });
        }
    }
    return out;
}
