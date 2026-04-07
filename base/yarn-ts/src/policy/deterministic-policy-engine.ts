import crypto from "node:crypto";

import type { GovernanceRule } from "./governance-client.js";

export interface PolicyContext {
  tools?: unknown[];
  repeatAttempt?: {
    action: string;
    args: unknown;
    fsFingerprint: string;
  };
  sessionKey?: string;
  sessionTokensIn?: number;
  /** Policy soft limit (after governance). Enforced: reject above. Audit: warn above, reject only at hardMaxInputTokens. */
  maxInputTokens?: number;
  /** Hard safety ceiling on session input tokens — reject above in both modes. */
  hardMaxInputTokens?: number;
  /** Default `enforced` — matches legacy single-threshold behavior. */
  sessionBudgetMode?: "audit" | "enforced";
  consecutiveToolCalls?: number;
  consecutiveToolCallsLimit?: number;
  consecutiveToolCallsPivot?: number;
  toolProgressState?: "stagnant" | "progress" | "unknown";
  stagnantToolCycles?: number;
  stagnantToolCyclesLimit?: number;
  toolLoopNoUserAckCount?: number;
  toolLoopNoUserAckHardLimit?: number;
  hardRejectAfter?: number;
  governanceRules?: GovernanceRule[];
}

export interface PolicyDecision {
  allow: boolean;
  rejectReason?: string;
  pivotPrompt?: string;
  softFailClass?: "tool_loop";
  matchedRules: string[];
}

export type PolicyEventKind =
  | "pivot_injected"
  | "hard_reject_repeats"
  | "hard_reject_budget"
  | "session_budget_soft_exceeded"
  | "hard_reject_tool_loop"
  | "patch_first_reject"
  | "rate_limit_reject"
  | "breaker_open_reject";

export interface PolicyEvent {
  kind: PolicyEventKind;
  sessionKey: string;
  detail: string;
  repeatCount?: number;
  tokensBurned?: number;
  consecutiveToolCalls?: number;
  timestamp: number;
}

export interface PolicyEngineStats {
  evaluations: number;
  rejectedCount: number;
  pivotCount: number;
  hardRejectRepeatCount: number;
  hardRejectBudgetCount: number;
  softSessionBudgetExceededCount: number;
  hardRejectToolLoopCount: number;
  repeatMapSize: number;
  repeatMapEvictions: number;
  recentEvents: PolicyEvent[];
}

type ToolLike = {
  function?: { name?: string };
  name?: string;
};

function extractToolName(tool: ToolLike): string | undefined {
  if (tool.function?.name && typeof tool.function.name === "string") return tool.function.name;
  if (tool.name && typeof tool.name === "string") return tool.name;
  return undefined;
}

function hashAttempt(sessionKey: string, action: string, args: unknown, fsFingerprint: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([sessionKey, action, args, fsFingerprint])).digest("hex");
}

const MAX_RECENT_EVENTS = 50;

interface RepeatEntry {
  count: number;
  lastSeen: number;
}

export class DeterministicPolicyEngine {
  private readonly repeatCounts = new Map<string, RepeatEntry>();
  private readonly recentEvents: PolicyEvent[] = [];
  private repeatMapEvictions = 0;
  private readonly maxRepeatEntries: number;
  private readonly repeatEntryTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private stats = {
    evaluations: 0,
    rejectedCount: 0,
    pivotCount: 0,
    hardRejectRepeatCount: 0,
    hardRejectBudgetCount: 0,
    softSessionBudgetExceededCount: 0,
    hardRejectToolLoopCount: 0,
  };

  constructor(opts?: { maxRepeatEntries?: number; repeatEntryTtlMs?: number }) {
    this.maxRepeatEntries = opts?.maxRepeatEntries ?? 5000;
    this.repeatEntryTtlMs = opts?.repeatEntryTtlMs ?? 1_800_000;
    this.sweepTimer = setInterval(() => this.sweepRepeatMap(), 60_000);
  }

  evaluate(ctx: PolicyContext): PolicyDecision {
    this.stats.evaluations += 1;
    const matchedRules: string[] = [];
    const sessionKey = ctx.sessionKey ?? "unknown";

    if (ctx.governanceRules?.length) {
      this.applyGovernanceOverrides(ctx);
      matchedRules.push("governance_overrides_applied");
    }

    for (const rawTool of ctx.tools ?? []) {
      const name = extractToolName((rawTool ?? {}) as ToolLike);
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
          rejectReason: "Patch-first policy violation: use str_replace/search-replace instead of write_file for non-trivial edits.",
          matchedRules
        };
      }
    }

    const policyLimit = ctx.maxInputTokens ?? 500_000;
    const hardLimit = ctx.hardMaxInputTokens ?? policyLimit;
    const mode = ctx.sessionBudgetMode ?? "enforced";
    const tokensIn = ctx.sessionTokensIn ?? 0;
    const policyCap = Math.min(policyLimit, hardLimit);

    if (tokensIn > 0) {
      if (tokensIn > hardLimit) {
        matchedRules.push("session_budget_exceeded");
        this.stats.rejectedCount += 1;
        this.stats.hardRejectBudgetCount += 1;
        this.recordEvent({
          kind: "hard_reject_budget",
          sessionKey,
          detail: `Session exceeded hard ${hardLimit.toLocaleString()} input token ceiling (used: ${tokensIn.toLocaleString()})`,
          tokensBurned: tokensIn,
          timestamp: Date.now()
        });
        return {
          allow: false,
          rejectReason: `Session token budget exceeded in ${mode} mode (observed: ${tokensIn.toLocaleString()} input tokens; soft: ${policyCap.toLocaleString()}; hard: ${hardLimit.toLocaleString()}). Start a new session.`,
          matchedRules
        };
      }

      if (mode === "enforced" && tokensIn > policyCap) {
        matchedRules.push("session_budget_exceeded");
        this.stats.rejectedCount += 1;
        this.stats.hardRejectBudgetCount += 1;
        this.recordEvent({
          kind: "hard_reject_budget",
          sessionKey,
          detail: `Session exceeded ${policyCap.toLocaleString()} input token budget (used: ${tokensIn.toLocaleString()})`,
          tokensBurned: tokensIn,
          timestamp: Date.now()
        });
        return {
          allow: false,
          rejectReason: `Session token budget exceeded in enforced mode (observed: ${tokensIn.toLocaleString()} input tokens; soft: ${policyCap.toLocaleString()}; hard: ${hardLimit.toLocaleString()}). Start a new session.`,
          matchedRules
        };
      }

      if (mode === "audit" && tokensIn > policyCap) {
        matchedRules.push("session_budget_soft_exceeded");
        this.stats.softSessionBudgetExceededCount += 1;
        this.recordEvent({
          kind: "session_budget_soft_exceeded",
          sessionKey,
          detail: `Session above policy soft limit in audit mode (observed: ${tokensIn.toLocaleString()} input tokens; soft: ${policyCap.toLocaleString()}; hard: ${hardLimit.toLocaleString()})`,
          tokensBurned: tokensIn,
          timestamp: Date.now()
        });
      }
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
        pivotPrompt:
          `System: You have made ${ctx.consecutiveToolCalls} consecutive tool calls without a stable resolution. Do not repeat the same broad verification command. First explain the root-cause hypothesis, then run one narrower command that validates that hypothesis. (${toolCallsLimit - ctx.consecutiveToolCalls} calls remaining before circuit breaker)`,
        matchedRules
      };
    }

    if (ctx.repeatAttempt) {
      // Scope by session: identical fingerprints from different conversations must not share one counter.
      const key = hashAttempt(ctx.sessionKey ?? "", ctx.repeatAttempt.action, ctx.repeatAttempt.args, ctx.repeatAttempt.fsFingerprint);
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
          pivotPrompt:
            `System: You have attempted this ${next} times without success. Do not rerun the same command unless code or inputs changed. Analyze the root cause, propose a different strategy, and validate with the narrowest possible command first. (${hardLimit - next} attempts remaining before circuit breaker)`,
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
  private applyGovernanceOverrides(ctx: PolicyContext): void {
    for (const rule of ctx.governanceRules ?? []) {
      if (!rule.rule_config || !rule.rule_type) continue;
      if (rule.rule_type === "threshold") {
        const cfg = rule.rule_config;
        if (typeof cfg.max_input_tokens === "number") ctx.maxInputTokens = cfg.max_input_tokens;
        if (typeof cfg.max_tool_calls === "number") ctx.consecutiveToolCallsLimit = cfg.max_tool_calls;
        if (typeof cfg.tool_calls_pivot === "number") ctx.consecutiveToolCallsPivot = cfg.tool_calls_pivot;
        if (typeof cfg.hard_reject_after === "number") ctx.hardRejectAfter = cfg.hard_reject_after;
        if (typeof cfg.stagnant_cycles_limit === "number") ctx.stagnantToolCyclesLimit = cfg.stagnant_cycles_limit;
      }
    }
  }

  getRecentEvents(): PolicyEvent[] {
    return [...this.recentEvents];
  }

  getStats(): PolicyEngineStats {
    return {
      ...this.stats,
      repeatMapSize: this.repeatCounts.size,
      repeatMapEvictions: this.repeatMapEvictions,
      recentEvents: [...this.recentEvents],
    };
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private recordEvent(event: PolicyEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }
  }

  private evictIfOverBound(): void {
    if (this.repeatCounts.size <= this.maxRepeatEntries) return;
    let oldestKey: string | null = null;
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

  private sweepRepeatMap(): void {
    const cutoff = Date.now() - this.repeatEntryTtlMs;
    for (const [key, entry] of this.repeatCounts) {
      if (entry.lastSeen < cutoff) {
        this.repeatCounts.delete(key);
        this.repeatMapEvictions += 1;
      }
    }
  }
}
