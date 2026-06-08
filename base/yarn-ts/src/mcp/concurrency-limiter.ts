import { createHash } from "node:crypto";

export interface McpConcurrencyLimits {
  maxPerCaller: number;
  maxGlobal: number;
}

export interface McpConcurrencyGrant {
  allowed: true;
  callerKey: string;
  callerActive: number;
  globalActive: number;
  release: () => void;
}

export interface McpConcurrencyRejection {
  allowed: false;
  reason: "caller_concurrency_exceeded" | "global_concurrency_exceeded";
  callerKey: string;
  callerActive: number;
  callerLimit: number;
  globalActive: number;
  globalLimit: number;
}

export type McpConcurrencyDecision = McpConcurrencyGrant | McpConcurrencyRejection;

export class McpConcurrencyLimiter {
  private readonly activeByCaller = new Map<string, number>();
  private activeGlobal = 0;

  constructor(private readonly limits: McpConcurrencyLimits) {}

  tryAcquire(input: { orgId: string; userId: string }): McpConcurrencyDecision {
    const callerKey = this.callerKey(input.orgId, input.userId);
    const callerActive = this.activeByCaller.get(callerKey) ?? 0;
    const maxPerCaller = Math.max(0, Math.floor(this.limits.maxPerCaller));
    const maxGlobal = Math.max(0, Math.floor(this.limits.maxGlobal));

    if (maxGlobal > 0 && this.activeGlobal >= maxGlobal) {
      return {
        allowed: false,
        reason: "global_concurrency_exceeded",
        callerKey,
        callerActive,
        callerLimit: maxPerCaller,
        globalActive: this.activeGlobal,
        globalLimit: maxGlobal,
      };
    }
    if (maxPerCaller > 0 && callerActive >= maxPerCaller) {
      return {
        allowed: false,
        reason: "caller_concurrency_exceeded",
        callerKey,
        callerActive,
        callerLimit: maxPerCaller,
        globalActive: this.activeGlobal,
        globalLimit: maxGlobal,
      };
    }

    this.activeGlobal += 1;
    this.activeByCaller.set(callerKey, callerActive + 1);
    let released = false;
    return {
      allowed: true,
      callerKey,
      callerActive: callerActive + 1,
      globalActive: this.activeGlobal,
      release: () => {
        if (released) return;
        released = true;
        this.activeGlobal = Math.max(0, this.activeGlobal - 1);
        const nextCallerActive = Math.max(0, (this.activeByCaller.get(callerKey) ?? 1) - 1);
        if (nextCallerActive === 0) {
          this.activeByCaller.delete(callerKey);
        } else {
          this.activeByCaller.set(callerKey, nextCallerActive);
        }
      },
    };
  }

  getActiveCounts(input: { orgId: string; userId: string }): { callerActive: number; globalActive: number } {
    const callerKey = this.callerKey(input.orgId, input.userId);
    return {
      callerActive: this.activeByCaller.get(callerKey) ?? 0,
      globalActive: this.activeGlobal,
    };
  }

  private callerKey(orgId: string, userId: string): string {
    const raw = `${orgId.trim() || "no-org"}:${userId.trim() || "unknown"}`;
    const encoded = encodeURIComponent(raw);
    if (encoded.length <= 180) return encoded;
    return `sha256-${createHash("sha256").update(raw).digest("hex")}`;
  }
}
