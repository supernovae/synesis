/**
 * Per-endpoint circuit breaker for model providers.
 *
 * State machine: closed (normal) → open (reject fast) → half-open (probe).
 * Ported from the retired planner runtime with identical semantics.
 * Keyed by `${modelId}:${orgId}` so one tenant's failures cannot deny
 * service to others.
 */

export const CLOSED = "closed" as const;
export const OPEN = "open" as const;
export const HALF_OPEN = "half_open" as const;

export type BreakerState = typeof CLOSED | typeof OPEN | typeof HALF_OPEN;

export interface CircuitBreakerStats {
  breakerCount: number;
  openBreakers: string[];
  halfOpenBreakers: string[];
}

class CircuitBreaker {
  private state: BreakerState = CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenCalls = 0;

  constructor(
    readonly name: string,
    private readonly failureThreshold: number,
    private readonly recoveryTimeoutMs: number,
    private readonly halfOpenMax: number,
  ) {}

  getState(): BreakerState {
    if (this.state === OPEN) {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeoutMs) {
        this.state = HALF_OPEN;
        this.halfOpenCalls = 0;
      }
    }
    return this.state;
  }

  allowRequest(): boolean {
    const s = this.getState();
    if (s === CLOSED) return true;
    if (s === HALF_OPEN) {
      if (this.halfOpenCalls < this.halfOpenMax) {
        this.halfOpenCalls += 1;
        return true;
      }
      return false;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = CLOSED;
    this.failureCount = 0;
  }

  recordFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.state === HALF_OPEN) {
      this.state = OPEN;
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = OPEN;
    }
  }
}

const MAX_BREAKERS = 2048;

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly halfOpenMax: number;

  constructor(opts?: {
    failureThreshold?: number;
    recoveryTimeoutMs?: number;
    halfOpenMax?: number;
  }) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.recoveryTimeoutMs = opts?.recoveryTimeoutMs ?? 60_000;
    this.halfOpenMax = opts?.halfOpenMax ?? 1;
  }

  private getBreaker(key: string): CircuitBreaker {
    let b = this.breakers.get(key);
    if (!b) {
      if (this.breakers.size >= MAX_BREAKERS) {
        const oldest = this.breakers.keys().next().value!;
        this.breakers.delete(oldest);
      }
      b = new CircuitBreaker(
        key,
        this.failureThreshold,
        this.recoveryTimeoutMs,
        this.halfOpenMax,
      );
      this.breakers.set(key, b);
    }
    return b;
  }

  allowRequest(modelId: string, orgId: string): boolean {
    const key = orgId ? `${modelId}:${orgId}` : modelId;
    return this.getBreaker(key).allowRequest();
  }

  recordSuccess(modelId: string, orgId: string): void {
    const key = orgId ? `${modelId}:${orgId}` : modelId;
    this.getBreaker(key).recordSuccess();
  }

  recordFailure(modelId: string, orgId: string): void {
    const key = orgId ? `${modelId}:${orgId}` : modelId;
    this.getBreaker(key).recordFailure();
  }

  getStats(): CircuitBreakerStats {
    const openBreakers: string[] = [];
    const halfOpenBreakers: string[] = [];
    for (const [key, b] of this.breakers) {
      const s = b.getState();
      if (s === OPEN) openBreakers.push(key);
      else if (s === HALF_OPEN) halfOpenBreakers.push(key);
    }
    return {
      breakerCount: this.breakers.size,
      openBreakers,
      halfOpenBreakers,
    };
  }
}
