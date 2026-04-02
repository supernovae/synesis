import crypto from "node:crypto";
import { classifyTool, extractReadPath, extractSearchQuery } from "../tool-collapse/tool-call-collapser.js";
import { hashToolCall } from "./ToolCallDedupe.js";
function contentHash(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}
function responseCacheKey(toolName, input, resultHash) {
    return `${hashToolCall(toolName, input)}\0${resultHash}`;
}
/**
 * When the same tool+args produced the same result hash before, return a compact stub
 * instead of reinjecting the full payload (reduces context / prefill).
 */
export class ResponseDedupe {
    cache;
    opts;
    constructor(cache, opts) {
        this.cache = cache;
        this.opts = opts;
    }
    /**
     * @returns JSON string (either full body or cached stub)
     */
    wrapToolResult(toolName, input, resultText) {
        const k = classifyTool(toolName);
        if (k === "run_tests" || k === "apply_patch") {
            return resultText;
        }
        if (k !== "read_file" && k !== "search") {
            return resultText;
        }
        const h = contentHash(resultText);
        const key = responseCacheKey(toolName, input, h);
        const prev = this.cache.getResponse(key);
        if (prev !== undefined) {
            this.opts.log?.({
                kind: "response_cached_stub",
                message: "dedupe: response reinjection shortened",
                detail: key.slice(0, 32),
            });
            const stub = {
                cached: true,
                note: "identical tool result as prior turn; full body omitted to save context",
                result_hash: h,
            };
            if (k === "read_file") {
                const p = extractReadPath(input);
                if (p)
                    stub.file = p;
            }
            if (k === "search") {
                const q = extractSearchQuery(input);
                if (q)
                    stub.query = q.query;
            }
            return JSON.stringify(stub);
        }
        this.cache.setResponse(key, resultText);
        return resultText;
    }
}
