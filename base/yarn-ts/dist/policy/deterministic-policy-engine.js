import crypto from "node:crypto";
function extractToolName(tool) {
    if (tool.function?.name && typeof tool.function.name === "string")
        return tool.function.name;
    if (tool.name && typeof tool.name === "string")
        return tool.name;
    return undefined;
}
function hashAttempt(action, args, fsFingerprint) {
    return crypto.createHash("sha256").update(JSON.stringify([action, args, fsFingerprint])).digest("hex");
}
const MAX_RECENT_EVENTS = 50;
export class DeterministicPolicyEngine {
    repeatCounts = new Map();
    recentEvents = [];
    repeatMapEvictions = 0;
    maxRepeatEntries;
    repeatEntryTtlMs;
    sweepTimer = null;
    stats = {
        evaluations: 0,
        rejectedCount: 0,
        pivotCount: 0,
        hardRejectRepeatCount: 0,
        hardRejectBudgetCount: 0,
        hardRejectToolLoopCount: 0,
    };
    constructor(opts) {
        this.maxRepeatEntries = opts?.maxRepeatEntries ?? 5000;
        this.repeatEntryTtlMs = opts?.repeatEntryTtlMs ?? 1_800_000;
        this.sweepTimer = setInterval(() => this.sweepRepeatMap(), 60_000);
    }
    evaluate(ctx) {
        this.stats.evaluations += 1;
        const matchedRules = [];
        const sessionKey = ctx.sessionKey ?? "unknown";
        if (ctx.governanceRules?.length) {
            this.applyGovernanceOverrides(ctx);
            matchedRules.push("governance_overrides_applied");
        }
        for (const rawTool of ctx.tools ?? []) {
            const name = extractToolName((rawTool ?? {}));
            if (name === "write_file") {
                matchedRules.push("patch_first_reject_write_file");
                this.stats.rejectedCount += 1;
                this.recordEvent({
                    kind: "patch_first_reject",
                    sessionKey,
                    detail: "write_file tool rejected by patch-first policy",
                    timestamp: Date.now()
                });
                return {
                    allow: false,
                    rejectReason: "Patch-first policy violation: use apply_patch/search-replace instead of write_file for non-trivial edits.",
                    matchedRules
                };
            }
        }
        const maxTokens = ctx.maxInputTokens ?? 500_000;
        if (ctx.sessionTokensIn && ctx.sessionTokensIn > maxTokens) {
            matchedRules.push("session_budget_exceeded");
            this.stats.rejectedCount += 1;
            this.stats.hardRejectBudgetCount += 1;
            this.recordEvent({
                kind: "hard_reject_budget",
                sessionKey,
                detail: `Session exceeded ${maxTokens.toLocaleString()} input token budget (used: ${ctx.sessionTokensIn.toLocaleString()})`,
                tokensBurned: ctx.sessionTokensIn,
                timestamp: Date.now()
            });
            return {
                allow: false,
                rejectReason: `Session token budget exceeded (${ctx.sessionTokensIn.toLocaleString()} / ${maxTokens.toLocaleString()} input tokens). Start a new session.`,
                matchedRules
            };
        }
        const toolCallsLimit = ctx.consecutiveToolCallsLimit ?? 15;
        const toolCallsPivot = ctx.consecutiveToolCallsPivot ?? 10;
        const stagnationLimit = Math.max(1, ctx.stagnantToolCyclesLimit ?? 4);
        const noUserAckLimit = Math.max(1, ctx.toolLoopNoUserAckHardLimit ?? 2);
        const progressState = ctx.toolProgressState ?? "unknown";
        const stagnantCycles = Math.max(0, ctx.stagnantToolCycles ?? 0);
        const noUserAckCount = Math.max(0, ctx.toolLoopNoUserAckCount ?? 0);
        const stagnationHardLimited = progressState === "stagnant" && stagnantCycles >= stagnationLimit;
        const noUserAckHardLimited = noUserAckCount >= noUserAckLimit;
        if (ctx.consecutiveToolCalls && ctx.consecutiveToolCalls >= toolCallsLimit && (stagnationHardLimited || noUserAckHardLimited)) {
            matchedRules.push("consecutive_tool_calls_limit");
            this.stats.rejectedCount += 1;
            this.stats.hardRejectToolLoopCount += 1;
            const detailSuffix = noUserAckHardLimited
                ? ` (soft-fail prompts ignored: ${noUserAckCount}, limit: ${noUserAckLimit})`
                : ` (stagnant cycles: ${stagnantCycles}, stagnation limit: ${stagnationLimit})`;
            this.recordEvent({
                kind: "hard_reject_tool_loop",
                sessionKey,
                detail: `${ctx.consecutiveToolCalls} consecutive tool_call responses without user interaction (limit: ${toolCallsLimit})${detailSuffix}`,
                consecutiveToolCalls: ctx.consecutiveToolCalls,
                timestamp: Date.now()
            });
            return {
                allow: false,
                rejectReason: noUserAckHardLimited
                    ? `Tool call loop detected: ${ctx.consecutiveToolCalls} consecutive tool_call responses and ${noUserAckCount} soft-fail prompts were ignored. Hard stop to prevent runaway token burn.`
                    : `Tool call loop detected: ${ctx.consecutiveToolCalls} consecutive tool_call responses with ${stagnantCycles} stagnant tool-result cycles. Ask for user guidance before continuing.`,
                softFailClass: "tool_loop",
                matchedRules
            };
        }
        if (ctx.consecutiveToolCalls && ctx.consecutiveToolCalls >= toolCallsPivot && progressState !== "progress") {
            matchedRules.push("consecutive_tool_calls_pivot");
            this.stats.pivotCount += 1;
            this.recordEvent({
                kind: "pivot_injected",
                sessionKey,
                detail: `Soft pivot at ${ctx.consecutiveToolCalls} consecutive tool calls (hard limit at ${toolCallsLimit})`,
                consecutiveToolCalls: ctx.consecutiveToolCalls,
                timestamp: Date.now()
            });
            return {
                allow: true,
                pivotPrompt: `System: You have made ${ctx.consecutiveToolCalls} consecutive tool calls without a text response. Stop calling tools and explain to the user what you are trying to do so they can help. (${toolCallsLimit - ctx.consecutiveToolCalls} calls remaining before circuit breaker)`,
                matchedRules
            };
        }
        if (ctx.repeatAttempt) {
            const key = hashAttempt(ctx.repeatAttempt.action, ctx.repeatAttempt.args, ctx.repeatAttempt.fsFingerprint);
            const existing = this.repeatCounts.get(key);
            const next = (existing?.count ?? 0) + 1;
            this.repeatCounts.set(key, { count: next, lastSeen: Date.now() });
            this.evictIfOverBound();
            const hardLimit = ctx.hardRejectAfter ?? 6;
            if (next >= hardLimit) {
                matchedRules.push("repeat_loop_hard_reject");
                this.stats.rejectedCount += 1;
                this.stats.hardRejectRepeatCount += 1;
                this.recordEvent({
                    kind: "hard_reject_repeats",
                    sessionKey,
                    detail: `${next} identical request patterns (limit: ${hardLimit}). Hard-rejected to prevent token waste.`,
                    repeatCount: next,
                    timestamp: Date.now()
                });
                return {
                    allow: false,
                    rejectReason: `Request pattern repeated ${next} times without progress. Circuit breaker activated. Start a new session or change your approach.`,
                    matchedRules
                };
            }
            if (next >= 3) {
                matchedRules.push("repeat_loop_pivot");
                this.stats.pivotCount += 1;
                this.recordEvent({
                    kind: "pivot_injected",
                    sessionKey,
                    detail: `Pivot prompt injected after ${next} repeats (hard limit at ${hardLimit})`,
                    repeatCount: next,
                    timestamp: Date.now()
                });
                return {
                    allow: true,
                    pivotPrompt: `System: You have attempted this ${next} times without success. Analyze the root cause and propose a new strategy before next action. (${hardLimit - next} attempts remaining before circuit breaker)`,
                    matchedRules
                };
            }
        }
        matchedRules.push("allow");
        return { allow: true, matchedRules };
    }
    /**
     * Applies governance rule overrides to the policy context.
     * Threshold rules override numeric limits; feature_toggle rules can
     * flip engine behavior without redeployment.
     */
    applyGovernanceOverrides(ctx) {
        for (const rule of ctx.governanceRules ?? []) {
            if (!rule.rule_config || !rule.rule_type)
                continue;
            if (rule.rule_type === "threshold") {
                const cfg = rule.rule_config;
                if (typeof cfg.max_input_tokens === "number")
                    ctx.maxInputTokens = cfg.max_input_tokens;
                if (typeof cfg.max_tool_calls === "number")
                    ctx.consecutiveToolCallsLimit = cfg.max_tool_calls;
                if (typeof cfg.tool_calls_pivot === "number")
                    ctx.consecutiveToolCallsPivot = cfg.tool_calls_pivot;
                if (typeof cfg.hard_reject_after === "number")
                    ctx.hardRejectAfter = cfg.hard_reject_after;
                if (typeof cfg.stagnant_cycles_limit === "number")
                    ctx.stagnantToolCyclesLimit = cfg.stagnant_cycles_limit;
            }
        }
    }
    getRecentEvents() {
        return [...this.recentEvents];
    }
    getStats() {
        return {
            ...this.stats,
            repeatMapSize: this.repeatCounts.size,
            repeatMapEvictions: this.repeatMapEvictions,
            recentEvents: [...this.recentEvents],
        };
    }
    close() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }
    recordEvent(event) {
        this.recentEvents.push(event);
        if (this.recentEvents.length > MAX_RECENT_EVENTS) {
            this.recentEvents.shift();
        }
    }
    evictIfOverBound() {
        if (this.repeatCounts.size <= this.maxRepeatEntries)
            return;
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this.repeatCounts) {
            if (entry.lastSeen < oldestTime) {
                oldestTime = entry.lastSeen;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            this.repeatCounts.delete(oldestKey);
            this.repeatMapEvictions += 1;
        }
    }
    sweepRepeatMap() {
        const cutoff = Date.now() - this.repeatEntryTtlMs;
        for (const [key, entry] of this.repeatCounts) {
            if (entry.lastSeen < cutoff) {
                this.repeatCounts.delete(key);
                this.repeatMapEvictions += 1;
            }
        }
    }
}
