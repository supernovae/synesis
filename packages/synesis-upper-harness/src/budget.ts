import type { BudgetDecision, MasterHarnessPolicyV1, TokenBudgetZone } from "./types.js";

function ratioLimit(ceiling: number, ratio: number): number {
  return Math.floor(ceiling * ratio);
}

export function classifyTokenBudgetZone(
  estimatedInputTokens: number,
  policy: MasterHarnessPolicyV1["token_budget"],
): TokenBudgetZone {
  const hardLimit = ratioLimit(policy.ceiling_tokens, policy.hard_ratio);
  const emergency = ratioLimit(policy.ceiling_tokens, policy.emergency_ratio);
  const heavy = ratioLimit(policy.ceiling_tokens, policy.heavy_ratio);
  const soft = ratioLimit(policy.ceiling_tokens, policy.soft_ratio);
  if (estimatedInputTokens >= hardLimit) return "reject";
  if (estimatedInputTokens >= emergency) return "emergency";
  if (estimatedInputTokens >= heavy) return "heavy";
  if (estimatedInputTokens >= soft) return "soft";
  return "green";
}

export function evaluateTokenBudget(
  estimatedInputTokens: number,
  policy: MasterHarnessPolicyV1,
): BudgetDecision {
  const tokenPolicy = policy.token_budget;
  const hardLimitTokens = ratioLimit(tokenPolicy.ceiling_tokens, tokenPolicy.hard_ratio);
  const emergencyTokens = ratioLimit(tokenPolicy.ceiling_tokens, tokenPolicy.emergency_ratio);
  const heavyTokens = ratioLimit(tokenPolicy.ceiling_tokens, tokenPolicy.heavy_ratio);
  const softTokens = ratioLimit(tokenPolicy.ceiling_tokens, tokenPolicy.soft_ratio);
  const safeEstimate = Math.max(0, Math.floor(estimatedInputTokens));
  const zone = classifyTokenBudgetZone(safeEstimate, tokenPolicy);
  const matchedRules = [`token_budget:${zone}`];
  if (zone === "reject") matchedRules.push("token_budget:hard_limit_exceeded");
  return {
    zone,
    estimatedInputTokens: safeEstimate,
    ceilingTokens: tokenPolicy.ceiling_tokens,
    outputReserveTokens: tokenPolicy.output_reserve_tokens,
    hardLimitTokens,
    emergencyTokens,
    heavyTokens,
    softTokens,
    headroomTokens: hardLimitTokens - safeEstimate,
    matchedRules,
  };
}
