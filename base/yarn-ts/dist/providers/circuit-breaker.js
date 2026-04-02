/**
 * Per-endpoint circuit breaker for model providers.
 *
 * State machine: closed (normal) → open (reject fast) → half-open (probe).
 * Ported from the retired planner runtime with identical semantics.
 * Keyed by `${modelId}:${orgId}` so one tenant's failures cannot deny
 * service to others.
 */
export const CLOSED = "closed";
export const OPEN = "open";
export const HALF_OPEN = "half_open";
class CircuitBreaker {
    name;
    failureThreshold;
    recoveryTimeoutMs;
    halfOpenMax;
    state = CLOSED;
    failureCount = 0;
    lastFailureTime = 0;
    halfOpenCalls = 0;
    constructor(name, failureThreshold, recoveryTimeoutMs, halfOpenMax) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.recoveryTimeoutMs = recoveryTimeoutMs;
        this.halfOpenMax = halfOpenMax;
    }
    getState() {
        if (this.state === OPEN) {
            if (Date.now() - this.lastFailureTime >= this.recoveryTimeoutMs) {
                this.state = HALF_OPEN;
                this.halfOpenCalls = 0;
            }
        }
        return this.state;
    }
    allowRequest() {
        const s = this.getState();
        if (s === CLOSED)
            return true;
        if (s === HALF_OPEN) {
            if (this.halfOpenCalls < this.halfOpenMax) {
                this.halfOpenCalls += 1;
                return true;
            }
            return false;
        }
        return false;
    }
    recordSuccess() {
        this.state = CLOSED;
        this.failureCount = 0;
    }
    recordFailure() {
        this.failureCount += 1;
        this.lastFailureTime = Date.now();
        if (this.state === HALF_OPEN) {
            this.state = OPEN;
        }
        else if (this.failureCount >= this.failureThreshold) {
            this.state = OPEN;
        }
    }
}
const MAX_BREAKERS = 2048;
export class CircuitBreakerRegistry {
    breakers = new Map();
    failureThreshold;
    recoveryTimeoutMs;
    halfOpenMax;
    constructor(opts) {
        this.failureThreshold = opts?.failureThreshold ?? 5;
        this.recoveryTimeoutMs = opts?.recoveryTimeoutMs ?? 60_000;
        this.halfOpenMax = opts?.halfOpenMax ?? 1;
    }
    getBreaker(key) {
        let b = this.breakers.get(key);
        if (!b) {
            if (this.breakers.size >= MAX_BREAKERS) {
                const oldest = this.breakers.keys().next().value;
                this.breakers.delete(oldest);
            }
            b = new CircuitBreaker(key, this.failureThreshold, this.recoveryTimeoutMs, this.halfOpenMax);
            this.breakers.set(key, b);
        }
        return b;
    }
    allowRequest(modelId, orgId) {
        const key = orgId ? `${modelId}:${orgId}` : modelId;
        return this.getBreaker(key).allowRequest();
    }
    recordSuccess(modelId, orgId) {
        const key = orgId ? `${modelId}:${orgId}` : modelId;
        this.getBreaker(key).recordSuccess();
    }
    recordFailure(modelId, orgId) {
        const key = orgId ? `${modelId}:${orgId}` : modelId;
        this.getBreaker(key).recordFailure();
    }
    getStats() {
        const openBreakers = [];
        const halfOpenBreakers = [];
        for (const [key, b] of this.breakers) {
            const s = b.getState();
            if (s === OPEN)
                openBreakers.push(key);
            else if (s === HALF_OPEN)
                halfOpenBreakers.push(key);
        }
        return {
            breakerCount: this.breakers.size,
            openBreakers,
            halfOpenBreakers,
        };
    }
}
