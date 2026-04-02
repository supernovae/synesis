import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Tinypool from "tinypool";
import { compactJsonArray } from "../reduction/json-compactor.js";
import { detectContentType, compressLogStream, summarizeJsonObject, } from "../reduction/content-dispatch.js";
export class EnrichmentPool {
    pool = null;
    enabled;
    poolSize;
    taskTimeoutMs;
    _completedTasks = 0;
    _failedTasks = 0;
    _syncFallbacks = 0;
    constructor(config) {
        this.enabled = config.SYNESIS_YARN_WORKER_POOL_ENABLED;
        const rawSize = config.SYNESIS_YARN_WORKER_POOL_SIZE;
        this.poolSize = rawSize > 0
            ? Math.min(rawSize, 8)
            : Math.min(Math.max(1, cpus().length - 1), 4);
        this.taskTimeoutMs = config.SYNESIS_YARN_WORKER_TASK_TIMEOUT_MS;
        if (this.enabled) {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = dirname(__filename);
            const workerFile = join(__dirname, "enrichment-worker.js");
            this.pool = new Tinypool({
                filename: workerFile,
                minThreads: 1,
                maxThreads: this.poolSize,
                idleTimeout: 60_000,
            });
        }
    }
    isAvailable() {
        return this.enabled && this.pool !== null;
    }
    async runTask(task) {
        if (!this.pool) {
            return this.syncFallback(task);
        }
        try {
            const result = await Promise.race([
                this.pool.run(task),
                this.timeout(),
            ]);
            this._completedTasks++;
            return result;
        }
        catch {
            this._failedTasks++;
            return this.syncFallback(task);
        }
    }
    async compactJsonAsync(raw, maxOutputItems) {
        if (!this.pool) {
            return compactJsonArray(raw, { maxOutputItems });
        }
        const result = await this.runTask({ type: "compact_json", raw, maxOutputItems });
        return result.type === "compact_json" ? result.result : compactJsonArray(raw, { maxOutputItems });
    }
    async dispatchContentAsync(raw) {
        if (!this.pool) {
            return this.syncDispatchContent(raw);
        }
        const result = await this.runTask({ type: "detect_content", raw });
        if (result.type === "detect_content") {
            return { contentType: result.contentType, transformed: result.transformed };
        }
        return this.syncDispatchContent(raw);
    }
    getStats() {
        return {
            enabled: this.enabled,
            poolSize: this.poolSize,
            completedTasks: this._completedTasks,
            pendingTasks: 0,
            failedTasks: this._failedTasks,
            syncFallbacks: this._syncFallbacks,
        };
    }
    async close() {
        if (this.pool) {
            await this.pool.destroy();
            this.pool = null;
        }
    }
    syncFallback(task) {
        this._syncFallbacks++;
        switch (task.type) {
            case "compact_json":
                return {
                    type: "compact_json",
                    result: compactJsonArray(task.raw, { maxOutputItems: task.maxOutputItems }),
                };
            case "detect_content":
                return this.syncDetectContent(task.raw);
            case "compress_log":
                return { type: "compress_log", compressed: compressLogStream(task.raw, task.maxLines) };
            case "summarize_json":
                return { type: "summarize_json", summary: summarizeJsonObject(task.raw, task.maxChars) };
        }
    }
    syncDetectContent(raw) {
        const contentType = detectContentType(raw);
        let transformed = null;
        if (contentType === "log-stream") {
            transformed = compressLogStream(raw);
        }
        else if (contentType === "json-object" && raw.length > 2000) {
            transformed = summarizeJsonObject(raw);
        }
        return { type: "detect_content", contentType, transformed };
    }
    syncDispatchContent(raw) {
        const contentType = detectContentType(raw);
        let transformed = null;
        if (contentType === "log-stream") {
            transformed = compressLogStream(raw);
        }
        else if (contentType === "json-object" && raw.length > 2000) {
            transformed = summarizeJsonObject(raw);
        }
        return { contentType, transformed };
    }
    timeout() {
        return new Promise((_, reject) => setTimeout(() => reject(new Error("Worker task timeout")), this.taskTimeoutMs));
    }
}
