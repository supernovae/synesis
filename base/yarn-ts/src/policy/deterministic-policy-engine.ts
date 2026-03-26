import crypto from "node:crypto";

export interface PolicyContext {
  tools?: unknown[];
  repeatAttempt?: {
    action: string;
    args: unknown;
    fsFingerprint: string;
  };
}

export interface PolicyDecision {
  allow: boolean;
  rejectReason?: string;
  pivotPrompt?: string;
  matchedRules: string[];
}

export interface PolicyEngineStats {
  evaluations: number;
  rejectedCount: number;
  pivotCount: number;
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

export class DeterministicPolicyEngine {
  private readonly repeatCounts = new Map<string, number>();
  private stats: PolicyEngineStats = {
    evaluations: 0,
    rejectedCount: 0,
    pivotCount: 0
  };

  evaluate(ctx: PolicyContext): PolicyDecision {
    this.stats.evaluations += 1;
    const matchedRules: string[] = [];

    // Rule 1: patch-first enforcement
    for (const rawTool of ctx.tools ?? []) {
      const name = extractToolName((rawTool ?? {}) as ToolLike);
      if (name === "write_file") {
        matchedRules.push("patch_first_reject_write_file");
        this.stats.rejectedCount += 1;
        return {
          allow: false,
          rejectReason: "Patch-first policy violation: use apply_patch/search-replace instead of write_file for non-trivial edits.",
          matchedRules
        };
      }
    }

    // Rule 2: repeat-loop pivot
    if (ctx.repeatAttempt) {
      const key = hashAttempt(ctx.repeatAttempt.action, ctx.repeatAttempt.args, ctx.repeatAttempt.fsFingerprint);
      const next = (this.repeatCounts.get(key) ?? 0) + 1;
      this.repeatCounts.set(key, next);
      if (next >= 3) {
        matchedRules.push("repeat_loop_pivot");
        this.stats.pivotCount += 1;
        return {
          allow: true,
          pivotPrompt:
            "System: You have attempted this 3 times without success. Analyze the root cause and propose a new strategy before next action.",
          matchedRules
        };
      }
    }

    matchedRules.push("allow");
    return { allow: true, matchedRules };
  }

  getStats(): PolicyEngineStats {
    return { ...this.stats };
  }
}
