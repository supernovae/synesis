import { compactJsonArray } from "../reduction/json-compactor.js";
import { detectContentType, compressLogStream, summarizeJsonObject, } from "../reduction/content-dispatch.js";
export default function handler(task) {
    switch (task.type) {
        case "compact_json":
            return {
                type: "compact_json",
                result: compactJsonArray(task.raw, {
                    maxOutputItems: task.maxOutputItems,
                }),
            };
        case "detect_content": {
            const contentType = detectContentType(task.raw);
            let transformed = null;
            if (contentType === "log-stream") {
                transformed = compressLogStream(task.raw);
            }
            else if (contentType === "json-object" && task.raw.length > 2000) {
                transformed = summarizeJsonObject(task.raw);
            }
            return { type: "detect_content", contentType, transformed };
        }
        case "compress_log":
            return {
                type: "compress_log",
                compressed: compressLogStream(task.raw, task.maxLines),
            };
        case "summarize_json":
            return {
                type: "summarize_json",
                summary: summarizeJsonObject(task.raw, task.maxChars),
            };
    }
}
