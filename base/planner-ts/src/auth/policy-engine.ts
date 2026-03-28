import type { AppConfig } from "../config.js";
import type { AuthContext } from "./types.js";
import { fgaCheck, type FgaCheckResult } from "./openfga-client.js";

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
  readonly engineName: "openfga";
  authorize(
    resource: PlannerResource,
    action: PlannerAction,
    auth: AuthContext,
    options?: AuthorizeOptions
  ): Promise<PolicyDecision>;
  getStats(): PolicyStats;
}

function hasScope(scopes: string[], prefix: string): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => scope.startsWith(prefix));
}

class OpenFgaPolicyEngine implements AuthorizationPolicyEngine {
  readonly engineName = "openfga" as const;
  private stats: PolicyStats = { evaluations: 0, rejectedCount: 0, recentEvents: [] };
  private static readonly MAX_RECENT_EVENTS = 50;

  async authorize(
    resource: PlannerResource,
    action: PlannerAction,
    auth: AuthContext,
    options?: AuthorizeOptions
  ): Promise<PolicyDecision> {
    this.stats.evaluations += 1;
    const traceId = options?.traceId ?? "unknown";
    const matchedRules: string[] = [];

    if (resource === "chat.completions" && action === "invoke") {
      matchedRules.push("resource_chat_completions");

      if (!hasScope(auth.tokenScopes, "model")) {
        this.stats.rejectedCount += 1;
        matchedRules.push("deny_missing_model_scope");
        const decision: PolicyDecision = {
          allow: false,
          rejectReason: "Token missing required scope: model",
          matchedRules,
        };
        this.recordEvent({ traceId, resource, action, allow: false, matchedRules, userId: auth.userId, timestamp: Date.now() });
        return decision;
      }
      matchedRules.push("scope_model_ok");

      const fgaUser = `user:${auth.userId}`;
      const fgaResult: FgaCheckResult = await fgaCheck(fgaUser, "can_invoke", "planner_endpoint", "chat_completions");

      if (!fgaResult.allowed) {
        this.stats.rejectedCount += 1;
        matchedRules.push("deny_openfga_planner_invoke");
        if (fgaResult.resolution) matchedRules.push(`fga:${fgaResult.resolution}`);
        const decision: PolicyDecision = {
          allow: false,
          rejectReason: "Authorization denied by policy",
          matchedRules,
        };
        this.recordEvent({ traceId, resource, action, allow: false, matchedRules, userId: auth.userId, timestamp: Date.now() });
        return decision;
      }
      matchedRules.push("allow_openfga_planner_invoke");

      const decision: PolicyDecision = { allow: true, matchedRules };
      this.recordEvent({ traceId, resource, action, allow: true, matchedRules, userId: auth.userId, timestamp: Date.now() });
      return decision;
    }

    this.stats.rejectedCount += 1;
    matchedRules.push("deny_unknown_resource");
    const decision: PolicyDecision = {
      allow: false,
      rejectReason: `Unsupported policy target: ${resource}:${action}`,
      matchedRules,
    };
    this.recordEvent({ traceId, resource, action, allow: false, matchedRules, userId: auth.userId, timestamp: Date.now() });
    return decision;
  }

  getStats(): PolicyStats {
    return { ...this.stats, recentEvents: [...this.stats.recentEvents] };
  }

  private recordEvent(event: PolicyEvent): void {
    this.stats.recentEvents.push(event);
    if (this.stats.recentEvents.length > OpenFgaPolicyEngine.MAX_RECENT_EVENTS) {
      this.stats.recentEvents.shift();
    }
  }
}

export function createAuthorizationPolicyEngine(_config: AppConfig): AuthorizationPolicyEngine {
  return new OpenFgaPolicyEngine();
}
