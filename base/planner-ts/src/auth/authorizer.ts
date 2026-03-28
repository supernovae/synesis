import type { AuthContext } from "./types.js";
import type { AuthorizationPolicyEngine, PolicyDecision } from "./policy-engine.js";

export async function authorizeChatCompletionsWithPolicy(
  policy: AuthorizationPolicyEngine,
  ctx: AuthContext,
  options?: { traceId?: string }
): Promise<PolicyDecision> {
  const decision = await policy.authorize("chat.completions", "invoke", ctx, options);
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
