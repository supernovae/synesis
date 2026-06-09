import crypto from "node:crypto";

export interface AdminMcpConcurrencyLimits {
  maxPerUser: number;
  maxGlobal: number;
}

export interface AdminMcpConcurrencyGrant {
  allowed: true;
  userKey: string;
  userActive: number;
  globalActive: number;
  release: () => void;
}

export interface AdminMcpConcurrencyRejection {
  allowed: false;
  reason: "user_concurrency_exceeded" | "global_concurrency_exceeded";
  userKey: string;
  userActive: number;
  userLimit: number;
  globalActive: number;
  globalLimit: number;
}

export type AdminMcpConcurrencyDecision = AdminMcpConcurrencyGrant | AdminMcpConcurrencyRejection;

const SAFE_KEY_PART_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

function concurrencyKeyPart(label: "org" | "user", value: string, fallback: string): string {
  const normalized = value.replace(/\0/g, "").trim() || fallback;
  if (SAFE_KEY_PART_RE.test(normalized)) return normalized;
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `${label}-${digest}`;
}

export class AdminMcpConcurrencyLimiter {
  private readonly activeByUser = new Map<string, number>();
  private activeGlobal = 0;

  constructor(private readonly limits: AdminMcpConcurrencyLimits) {}

  tryAcquire(input: { orgId: string; userId: string }): AdminMcpConcurrencyDecision {
    const userKey = this.userKey(input.orgId, input.userId);
    const userActive = this.activeByUser.get(userKey) ?? 0;
    const maxPerUser = Math.max(0, Math.floor(this.limits.maxPerUser));
    const maxGlobal = Math.max(0, Math.floor(this.limits.maxGlobal));

    if (maxGlobal > 0 && this.activeGlobal >= maxGlobal) {
      return {
        allowed: false,
        reason: "global_concurrency_exceeded",
        userKey,
        userActive,
        userLimit: maxPerUser,
        globalActive: this.activeGlobal,
        globalLimit: maxGlobal,
      };
    }
    if (maxPerUser > 0 && userActive >= maxPerUser) {
      return {
        allowed: false,
        reason: "user_concurrency_exceeded",
        userKey,
        userActive,
        userLimit: maxPerUser,
        globalActive: this.activeGlobal,
        globalLimit: maxGlobal,
      };
    }

    this.activeGlobal += 1;
    this.activeByUser.set(userKey, userActive + 1);
    let released = false;
    return {
      allowed: true,
      userKey,
      userActive: userActive + 1,
      globalActive: this.activeGlobal,
      release: () => {
        if (released) return;
        released = true;
        this.activeGlobal = Math.max(0, this.activeGlobal - 1);
        const nextUserActive = Math.max(0, (this.activeByUser.get(userKey) ?? 1) - 1);
        if (nextUserActive === 0) {
          this.activeByUser.delete(userKey);
        } else {
          this.activeByUser.set(userKey, nextUserActive);
        }
      },
    };
  }

  private userKey(orgId: string, userId: string): string {
    return `${concurrencyKeyPart("org", orgId, "no-org")}:${concurrencyKeyPart("user", userId, "unknown")}`;
  }
}
