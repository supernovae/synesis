import type { AuthContext } from "./types.js";
import type { AuthorizationPolicyEngine, PolicyDecision } from "./policy-engine.js";

function hasScope(scopes: string[], prefix: string): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => scope.startsWith(prefix));
}

export function authorizeChatCompletions(ctx: AuthContext): void {
  if (!hasScope(ctx.tokenScopes, "model")) {
    const err = new Error("Token missing required scope: model");
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
}

export function authorizeChatCompletionsWithPolicy(
  policy: AuthorizationPolicyEngine,
  ctx: AuthContext,
  options?: { traceId?: string }
): PolicyDecision {
  const decision = policy.authorize("chat.completions", "invoke", ctx, options);
  if (!decision.allow) {
    const err = new Error(decision.rejectReason ?? "Authorization denied");
    (
      err as Error & {
        statusCode?: number;
        policyDecision?: PolicyDecision;
      }
    ).statusCode = 403;
    (
      err as Error & {
        statusCode?: number;
        policyDecision?: PolicyDecision;
      }
    ).policyDecision = decision;
    throw err;
  }
  return decision;
}
