import crypto from "node:crypto";

export interface PolicyContext {
  tools?: unknown[];
  repeatAttempt?: {
    action: string;
    args: unknown;
    fsFingerprint: string;
  };
  sessionKey?: string;
  sessionTokensIn?: number;
  maxInputTokens?: number;
  consecutiveToolCalls?: number;
  consecutiveToolCallsLimit?: number;
  consecutiveToolCallsPivot?: number;
  hardRejectAfter?: number;
}

export interface PolicyDecision {
  allow: boolean;
  rejectReason?: string;
  pivotPrompt?: string;
  matchedRules: string[];
}

export type PolicyEventKind =
  | "pivot_injected"
  | "hard_reject_repeats"
  | "hard_reject_budget"
  | "hard_reject_tool_loop"
  | "patch_first_reject";

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
  hardRejectToolLoopCount: number;
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

function hashAttempt(action: string, args: unknown, fsFingerprint: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([action, args, fsFingerprint])).digest("hex");
}

const MAX_RECENT_EVENTS = 50;

export class DeterministicPolicyEngine {
  private readonly repeatCounts = new Map<string, number>();
  private readonly recentEvents: PolicyEvent[] = [];
  private stats: PolicyEngineStats = {
    evaluations: 0,
    rejectedCount: 0,
    pivotCount: 0,
    hardRejectRepeatCount: 0,
    hardRejectBudgetCount: 0,
    hardRejectToolLoopCount: 0,
    recentEvents: []
  };

  evaluate(ctx: PolicyContext): PolicyDecision {
    this.stats.evaluations += 1;
    const matchedRules: string[] = [];
    const sessionKey = ctx.sessionKey ?? "unknown";

    // Rule 1: patch-first enforcement
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
          rejectReason: "Patch-first policy violation: use apply_patch/search-replace instead of write_file for non-trivial edits.",
          matchedRules
        };
      }
    }

    // Rule 2: session token budget
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

    // Rule 3: consecutive tool_calls — soft pivot then hard reject
    const toolCallsLimit = ctx.consecutiveToolCallsLimit ?? 15;
    const toolCallsPivot = ctx.consecutiveToolCallsPivot ?? 10;
    if (ctx.consecutiveToolCalls && ctx.consecutiveToolCalls >= toolCallsLimit) {
      matchedRules.push("consecutive_tool_calls_limit");
      this.stats.rejectedCount += 1;
      this.stats.hardRejectToolLoopCount += 1;
      this.recordEvent({
        kind: "hard_reject_tool_loop",
        sessionKey,
        detail: `${ctx.consecutiveToolCalls} consecutive tool_call responses without user interaction (limit: ${toolCallsLimit})`,
        consecutiveToolCalls: ctx.consecutiveToolCalls,
        timestamp: Date.now()
      });
      return {
        allow: false,
        rejectReason: `Tool call loop detected: ${ctx.consecutiveToolCalls} consecutive tool_call responses without progress. The model may be stuck. Start a new session or provide guidance.`,
        matchedRules
      };
    }
    if (ctx.consecutiveToolCalls && ctx.consecutiveToolCalls >= toolCallsPivot) {
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
          `System: You have made ${ctx.consecutiveToolCalls} consecutive tool calls without a text response. Stop calling tools and explain to the user what you are trying to do so they can help. (${toolCallsLimit - ctx.consecutiveToolCalls} calls remaining before circuit breaker)`,
        matchedRules
      };
    }

    // Rule 4: repeat-loop pivot + hard reject
    if (ctx.repeatAttempt) {
      const key = hashAttempt(ctx.repeatAttempt.action, ctx.repeatAttempt.args, ctx.repeatAttempt.fsFingerprint);
      const next = (this.repeatCounts.get(key) ?? 0) + 1;
      this.repeatCounts.set(key, next);

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
            `System: You have attempted this ${next} times without success. Analyze the root cause and propose a new strategy before next action. (${hardLimit - next} attempts remaining before circuit breaker)`,
          matchedRules
        };
      }
    }

    matchedRules.push("allow");
    return { allow: true, matchedRules };
  }

  getRecentEvents(): PolicyEvent[] {
    return [...this.recentEvents];
  }

  getStats(): PolicyEngineStats {
    return { ...this.stats, recentEvents: [...this.recentEvents] };
  }

  private recordEvent(event: PolicyEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }
  }
}
