import { ReducerRegistry, registeredFamilies } from "./registry.js";
import { compactJsonArray } from "./json-compactor.js";
import { ContentDispatchService } from "./content-dispatch.js";
import { makeRecallDecision } from "../recall/routing.js";
import { createEmptyRecallStats } from "../recall/types.js";
import { getLanguagePackRegistry } from "../language-packs/index.js";
import { VerificationLoopTracker } from "../verification/loop-tracker.js";
import { getVerificationToolNames } from "../verification/planner.js";
import { createEmptyVerificationStats } from "../verification/types.js";
import { formatSelfRepairBlock } from "../recall/formatter.js";
function toStringContent(content) {
    if (typeof content === "string")
        return content;
    try {
        return JSON.stringify(content);
    }
    catch {
        return String(content);
    }
}
function buildByFamilyStats() {
    const stats = { generic: 0 };
    for (const f of registeredFamilies())
        stats[f] = 0;
    return stats;
}
export class ToolResultReductionService {
    config;
    artifactStore;
    stats = {
        rawCharsTotal: 0,
        reducedCharsTotal: 0,
        reducedCount: 0,
        shrunkCount: 0,
        expandedCount: 0,
        unchangedCount: 0,
        netCharsSavedTotal: 0,
        artifactHandleCount: 0,
        tokensSavedEstimateTotal: 0,
        fallbackToArtifactCount: 0,
        jsonCompactionCount: 0,
        contentDispatchCount: 0,
        reducerFailures: 0,
        compactionFailures: 0,
        enrichedCount: 0,
        bypassEligibleCount: 0,
        byFamily: buildByFamilyStats(),
        lifecycle: {}
    };
    registry;
    contentDispatch;
    recallStats = createEmptyRecallStats();
    recallConfig;
    _lastRecallDecision = null;
    verificationTracker = new VerificationLoopTracker();
    verificationStats = createEmptyVerificationStats();
    _verificationToolNames = null;
    constructor(config, artifactStore) {
        this.config = config;
        this.artifactStore = artifactStore;
        const disabledFamilies = new Set(config.SYNESIS_YARN_REDUCER_DISABLED_FAMILIES.split(",")
            .map((s) => s.trim())
            .filter(Boolean));
        this.contentDispatch = config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED
            ? new ContentDispatchService()
            : null;
        this.registry = new ReducerRegistry({
            enabled: config.SYNESIS_YARN_REDUCERS_ENABLED,
            disabledFamilies,
            minConfidence: config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
        });
        this.recallConfig = {
            enabled: config.SYNESIS_YARN_RECALL_BYPASS_ENABLED,
            bypassConfidenceThreshold: config.SYNESIS_YARN_RECALL_BYPASS_CONFIDENCE_THRESHOLD,
            enrichConfidenceThreshold: config.SYNESIS_YARN_RECALL_ENRICH_THRESHOLD,
        };
    }
    reduceMessages(messages) {
        let reducedCount = 0;
        const out = messages.map((m) => {
            if (m.role !== "tool")
                return m;
            const raw = toStringContent(m.content);
            const dispatched = this.contentDispatch?.dispatch(raw);
            if (dispatched?.transformed) {
                this.stats.contentDispatchCount += 1;
                this.trackTransformation(raw.length, dispatched.transformed.length);
                reducedCount += 1;
                return { ...m, content: dispatched.transformed };
            }
            let reduced;
            try {
                reduced = this.registry.reduce({
                    raw,
                    context: {
                        toolName: m.name,
                        command: m.name,
                        profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
                        maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
                        minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
                    }
                });
            }
            catch {
                this.stats.compactionFailures += 1;
                reduced = null;
            }
            const shouldReduce = Boolean(reduced) || raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS;
            if (!shouldReduce)
                return { ...m, content: raw };
            let summary;
            if (reduced) {
                summary = reduced.summary;
                this.stats.byFamily[reduced.family] += 1;
                if (reduced.enrichedItems && reduced.enrichedItems.length > 0)
                    this.stats.enrichedCount += 1;
                if (reduced.bypassEligible)
                    this.stats.bypassEligibleCount += 1;
                if (reduced.enrichedItems && reduced.enrichedItems.length > 0) {
                    const registry = getLanguagePackRegistry();
                    const decision = makeRecallDecision(reduced.enrichedItems, reduced.bypassEligible ?? false, registry, this.recallConfig, reduced.family, this.recallStats);
                    this._lastRecallDecision = decision;
                    const isVerify = this.isVerificationOutput(m.name);
                    if (isVerify) {
                        const loopState = this.verificationTracker.recordRound(m.name ?? "unknown", reduced.enrichedItems, reduced.bypassEligible ?? false, this.verificationStats, decision.resolution?.language);
                        if (decision.routing !== "passthrough" && decision.resolution) {
                            const selfRepair = formatSelfRepairBlock(decision.resolution, loopState);
                            if (selfRepair) {
                                this.verificationStats.selfRepairSuggestions++;
                                summary = summary + "\n" + selfRepair;
                            }
                        }
                        const progress = this.verificationTracker.formatProgressAnnotation();
                        if (progress) {
                            summary = summary + "\n" + progress;
                        }
                    }
                    else {
                        if (decision.routing === "bypass" && decision.syntheticBlock) {
                            summary = decision.syntheticBlock;
                        }
                        else if (decision.routing === "enrich" && decision.enrichmentBlock) {
                            summary = summary + "\n" + decision.enrichmentBlock;
                        }
                    }
                }
            }
            else {
                const jsonResult = compactJsonArray(raw, { artifactHandle: this.artifactStore.putToolResult(raw).id });
                if (jsonResult && jsonResult.compressionRatio > 0.2) {
                    summary = jsonResult.compacted;
                    this.stats.jsonCompactionCount += 1;
                }
                else {
                    summary = this.artifactSummary(raw, m.name);
                    this.stats.fallbackToArtifactCount += 1;
                    this.stats.reducerFailures += 1;
                }
            }
            this.trackTransformation(raw.length, summary.length);
            if (summary.includes("artifact_handle="))
                this.stats.artifactHandleCount += 1;
            reducedCount += 1;
            return {
                ...m,
                content: summary
            };
        });
        return { messages: out, reducedCount };
    }
    /**
     * Async variant of reduceMessages that fans out stateless content dispatch
     * and JSON compaction to worker threads for parallel processing.
     * Falls back to sync reduceMessages when pool is unavailable.
     */
    async reduceMessagesAsync(messages, pool) {
        if (!pool.isAvailable()) {
            return this.reduceMessages(messages);
        }
        const toolIndices = [];
        const dispatchPromises = [];
        const rawStrings = [];
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === "tool") {
                const raw = toStringContent(messages[i].content);
                toolIndices.push(i);
                rawStrings.push(raw);
                dispatchPromises.push(this.contentDispatch ? pool.dispatchContentAsync(raw) : Promise.resolve({ contentType: "unknown", transformed: null }));
            }
        }
        const dispatched = await Promise.all(dispatchPromises);
        let reducedCount = 0;
        const out = [...messages];
        for (let j = 0; j < toolIndices.length; j++) {
            const idx = toolIndices[j];
            const m = messages[idx];
            const raw = rawStrings[j];
            const dispatch = dispatched[j];
            if (dispatch.transformed) {
                this.stats.contentDispatchCount += 1;
                this.trackTransformation(raw.length, dispatch.transformed.length);
                reducedCount += 1;
                out[idx] = { ...m, content: dispatch.transformed };
                continue;
            }
            let reduced;
            try {
                reduced = this.registry.reduce({
                    raw,
                    context: {
                        toolName: m.name,
                        command: m.name,
                        profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
                        maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
                        minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE,
                    },
                });
            }
            catch {
                this.stats.compactionFailures += 1;
                reduced = null;
            }
            const shouldReduce = Boolean(reduced) || raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS;
            if (!shouldReduce) {
                out[idx] = { ...m, content: raw };
                continue;
            }
            let summary;
            if (reduced) {
                summary = reduced.summary;
                this.stats.byFamily[reduced.family] += 1;
                if (reduced.enrichedItems && reduced.enrichedItems.length > 0)
                    this.stats.enrichedCount += 1;
                if (reduced.bypassEligible)
                    this.stats.bypassEligibleCount += 1;
                if (reduced.enrichedItems && reduced.enrichedItems.length > 0) {
                    const registry = getLanguagePackRegistry();
                    const decision = makeRecallDecision(reduced.enrichedItems, reduced.bypassEligible ?? false, registry, this.recallConfig, reduced.family, this.recallStats);
                    this._lastRecallDecision = decision;
                    const isVerify = this.isVerificationOutput(m.name);
                    if (isVerify) {
                        const loopState = this.verificationTracker.recordRound(m.name ?? "unknown", reduced.enrichedItems, reduced.bypassEligible ?? false, this.verificationStats, decision.resolution?.language);
                        if (decision.routing !== "passthrough" && decision.resolution) {
                            const selfRepair = formatSelfRepairBlock(decision.resolution, loopState);
                            if (selfRepair) {
                                this.verificationStats.selfRepairSuggestions++;
                                summary = summary + "\n" + selfRepair;
                            }
                        }
                        const progress = this.verificationTracker.formatProgressAnnotation();
                        if (progress) {
                            summary = summary + "\n" + progress;
                        }
                    }
                    else {
                        if (decision.routing === "bypass" && decision.syntheticBlock) {
                            summary = decision.syntheticBlock;
                        }
                        else if (decision.routing === "enrich" && decision.enrichmentBlock) {
                            summary = summary + "\n" + decision.enrichmentBlock;
                        }
                    }
                }
            }
            else {
                const compactResult = await pool.compactJsonAsync(raw);
                if (compactResult && compactResult.compressionRatio > 0.2) {
                    summary = compactResult.compacted;
                    this.stats.jsonCompactionCount += 1;
                }
                else {
                    summary = this.artifactSummary(raw, m.name);
                    this.stats.fallbackToArtifactCount += 1;
                    this.stats.reducerFailures += 1;
                }
            }
            this.trackTransformation(raw.length, summary.length);
            if (summary.includes("artifact_handle="))
                this.stats.artifactHandleCount += 1;
            reducedCount += 1;
            out[idx] = { ...m, content: summary };
        }
        return { messages: out, reducedCount };
    }
    reduceStandaloneToolResult(content, toolName) {
        const raw = toStringContent(content);
        let reduced;
        try {
            reduced = this.registry.reduce({
                raw,
                context: {
                    toolName,
                    command: toolName,
                    profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
                    maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
                    minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
                }
            });
        }
        catch {
            this.stats.compactionFailures += 1;
            reduced = null;
        }
        if (!reduced && raw.length <= this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS) {
            const jsonResult = compactJsonArray(raw);
            if (jsonResult && jsonResult.compressionRatio > 0.2) {
                this.stats.jsonCompactionCount += 1;
                this.trackTransformation(raw.length, jsonResult.compacted.length);
                return jsonResult.compacted;
            }
            return raw;
        }
        let summary;
        if (reduced) {
            summary = reduced.summary;
            this.stats.byFamily[reduced.family] += 1;
            if (reduced.enrichedItems && reduced.enrichedItems.length > 0)
                this.stats.enrichedCount += 1;
            if (reduced.bypassEligible)
                this.stats.bypassEligibleCount += 1;
            if (reduced.enrichedItems && reduced.enrichedItems.length > 0) {
                const registry = getLanguagePackRegistry();
                const decision = makeRecallDecision(reduced.enrichedItems, reduced.bypassEligible ?? false, registry, this.recallConfig, reduced.family, this.recallStats);
                this._lastRecallDecision = decision;
                const isVerify = this.isVerificationOutput(toolName);
                if (isVerify) {
                    const loopState = this.verificationTracker.recordRound(toolName ?? "unknown", reduced.enrichedItems, reduced.bypassEligible ?? false, this.verificationStats, decision.resolution?.language);
                    if (decision.routing !== "passthrough" && decision.resolution) {
                        const selfRepair = formatSelfRepairBlock(decision.resolution, loopState);
                        if (selfRepair) {
                            this.verificationStats.selfRepairSuggestions++;
                            summary = summary + "\n" + selfRepair;
                        }
                    }
                    const progress = this.verificationTracker.formatProgressAnnotation();
                    if (progress) {
                        summary = summary + "\n" + progress;
                    }
                }
                else {
                    if (decision.routing === "bypass" && decision.syntheticBlock) {
                        summary = decision.syntheticBlock;
                    }
                    else if (decision.routing === "enrich" && decision.enrichmentBlock) {
                        summary = summary + "\n" + decision.enrichmentBlock;
                    }
                }
            }
        }
        else {
            const jsonResult = compactJsonArray(raw, { artifactHandle: this.artifactStore.putToolResult(raw).id });
            if (jsonResult && jsonResult.compressionRatio > 0.2) {
                summary = jsonResult.compacted;
                this.stats.jsonCompactionCount += 1;
            }
            else {
                summary = this.artifactSummary(raw, toolName);
                this.stats.fallbackToArtifactCount += 1;
                this.stats.reducerFailures += 1;
            }
        }
        this.trackTransformation(raw.length, summary.length);
        if (summary.includes("artifact_handle="))
            this.stats.artifactHandleCount += 1;
        return summary;
    }
    _savedCheckpoint = 0;
    /** Returns estimated tokens saved since the last call (per-request delta). */
    getPerRequestDelta() {
        const current = this.stats.tokensSavedEstimateTotal;
        const delta = current - this._savedCheckpoint;
        this._savedCheckpoint = current;
        return Math.max(0, delta);
    }
    getStats() {
        this.stats.lifecycle = this.registry.lifecycleStates();
        const dispatchStats = this.contentDispatch?.getStats() ?? { dispatched: 0, byType: { "json-array": 0, "json-object": 0, "log-stream": 0, text: 0 } };
        return { ...this.stats, contentDispatch: dispatchStats, recall: this.recallStats };
    }
    getRecallStats() {
        return this.recallStats;
    }
    getLastRecallDecision() {
        return this._lastRecallDecision;
    }
    getVerificationStats() {
        return this.verificationStats;
    }
    getVerificationTracker() {
        return this.verificationTracker;
    }
    isVerificationOutput(toolName) {
        if (!toolName)
            return false;
        if (!this._verificationToolNames) {
            this._verificationToolNames = getVerificationToolNames(getLanguagePackRegistry());
        }
        const lower = toolName.toLowerCase();
        if (lower.includes("run_test") || lower.includes("run_build") || lower.includes("run_lint")) {
            return true;
        }
        for (const vt of this._verificationToolNames) {
            if (lower.includes(vt))
                return true;
        }
        return false;
    }
    trackTransformation(rawChars, outChars) {
        this.stats.rawCharsTotal += rawChars;
        this.stats.reducedCharsTotal += outChars;
        this.stats.reducedCount += 1;
        this.stats.netCharsSavedTotal += rawChars - outChars;
        this.stats.tokensSavedEstimateTotal += Math.max(0, Math.ceil(rawChars / 4) - Math.ceil(outChars / 4));
        if (outChars < rawChars)
            this.stats.shrunkCount += 1;
        else if (outChars > rawChars)
            this.stats.expandedCount += 1;
        else
            this.stats.unchangedCount += 1;
    }
    artifactSummary(raw, toolName) {
        const artifact = this.artifactStore.putToolResult(raw);
        return [
            `<TOOL_RESULT_SUMMARY tool="${toolName ?? "unknown"}" chars="${raw.length}" truncated="true">`,
            `artifact_handle=${artifact.id}`,
            `preview=${artifact.preview}`,
            "</TOOL_RESULT_SUMMARY>"
        ].join("\n");
    }
}
