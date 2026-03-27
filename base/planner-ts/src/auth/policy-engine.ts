import type { AppConfig } from "../config.js";
import type { AuthContext } from "./types.js";

export type PlannerResource = "chat.completions";
export type PlannerAction = "invoke";

export interface PolicyDecision {
  allow: boolean;
  rejectReason?: string;
  matchedRules: string[];
}

export interface PolicyStats {
  evaluations: number;
  rejectedCount: number;
  recentEvents: PolicyEvent[];
}

export interface PolicyEvent {
  traceId: string;
  resource: PlannerResource;
  action: PlannerAction;
  allow: boolean;
  matchedRules: string[];
  userId: string;
  timestamp: number;
}

export interface AuthorizeOptions {
  traceId?: string;
}

export interface AuthorizationPolicyEngine {
  readonly engineName: "deterministic" | "openfga_stub" | "openfga_shadow";
  authorize(
    resource: PlannerResource,
    action: PlannerAction,
    auth: AuthContext,
    options?: AuthorizeOptions
  ): PolicyDecision;
  getStats(): PolicyStats;
}

function hasScope(scopes: string[], prefix: string): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => scope.startsWith(prefix));
}

class DeterministicAuthorizationPolicyEngine implements AuthorizationPolicyEngine {
  readonly engineName = "deterministic" as const;
  private stats: PolicyStats = { evaluations: 0, rejectedCount: 0, recentEvents: [] };
  private static readonly MAX_RECENT_EVENTS = 50;

  authorize(
    resource: PlannerResource,
    action: PlannerAction,
    auth: AuthContext,
    options?: AuthorizeOptions
  ): PolicyDecision {
    this.stats.evaluations += 1;
    const traceId = options?.traceId ?? "unknown";
    const matchedRules: string[] = [];

    if (resource === "chat.completions" && action === "invoke") {
      matchedRules.push("resource_chat_completions");
      if (!hasScope(auth.tokenScopes, "model")) {
        this.stats.rejectedCount += 1;
        matchedRules.push("deny_missing_model_scope");
        const decision = {
          allow: false,
          rejectReason: "Token missing required scope: model",
          matchedRules
        };
        this.recordEvent({
          traceId,
          resource,
          action,
          allow: decision.allow,
          matchedRules,
          userId: auth.userId,
          timestamp: Date.now()
        });
        return decision;
      }
      matchedRules.push("allow_model_scope");
      const decision = { allow: true, matchedRules };
      this.recordEvent({
        traceId,
        resource,
        action,
        allow: decision.allow,
        matchedRules,
        userId: auth.userId,
        timestamp: Date.now()
      });
      return decision;
    }

    this.stats.rejectedCount += 1;
    matchedRules.push("deny_unknown_resource");
    const decision = {
      allow: false,
      rejectReason: `Unsupported policy target: ${resource}:${action}`,
      matchedRules
    };
    this.recordEvent({
      traceId,
      resource,
      action,
      allow: decision.allow,
      matchedRules,
      userId: auth.userId,
      timestamp: Date.now()
    });
    return decision;
  }

  getStats(): PolicyStats {
    return { ...this.stats, recentEvents: [...this.stats.recentEvents] };
  }

  private recordEvent(event: PolicyEvent): void {
    this.stats.recentEvents.push(event);
    if (this.stats.recentEvents.length > DeterministicAuthorizationPolicyEngine.MAX_RECENT_EVENTS) {
      this.stats.recentEvents.shift();
    }
  }
}

class OpenFgaStubAuthorizationPolicyEngine implements AuthorizationPolicyEngine {
  readonly engineName = "openfga_stub" as const;
  private stats: PolicyStats = { evaluations: 0, rejectedCount: 0, recentEvents: [] };
  private static readonly MAX_RECENT_EVENTS = 50;

  authorize(
    resource: PlannerResource,
    action: PlannerAction,
    auth: AuthContext,
    options?: AuthorizeOptions
  ): PolicyDecision {
    this.stats.evaluations += 1;
    this.stats.rejectedCount += 1;
    const decision = {
      allow: false,
      rejectReason: `Authz engine '${this.engineName}' is not configured yet for ${resource}:${action}`,
      matchedRules: ["deny_engine_not_configured"]
    };
    this.stats.recentEvents.push({
      traceId: options?.traceId ?? "unknown",
      resource,
      action,
      allow: decision.allow,
      matchedRules: decision.matchedRules,
      userId: auth.userId,
      timestamp: Date.now()
    });
    if (this.stats.recentEvents.length > OpenFgaStubAuthorizationPolicyEngine.MAX_RECENT_EVENTS) {
      this.stats.recentEvents.shift();
    }
    return decision;
  }

  getStats(): PolicyStats {
    return { ...this.stats, recentEvents: [...this.stats.recentEvents] };
  }
}

export function createAuthorizationPolicyEngine(config: AppConfig): AuthorizationPolicyEngine {
  const engine = config.SYNESIS_AUTHZ_ENGINE !== "deterministic"
    ? config.SYNESIS_AUTHZ_ENGINE
    : config.SYNESIS_PLANNER_TS_AUTHZ_ENGINE;

  if (engine === "openfga_stub" || engine === "openfga_shadow") {
    return new OpenFgaStubAuthorizationPolicyEngine();
  }
  return new DeterministicAuthorizationPolicyEngine();
}
