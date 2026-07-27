export interface ModelComplianceAssessment {
  passed: boolean;
  reasons: string[];
}

export function assessTrustPolicyResponse(
  response: string,
  requiredTerms: string[],
  forbiddenTokens: string[],
): ModelComplianceAssessment {
  const normalized = response.toLowerCase();
  const reasons = [
    ...requiredTerms
      .filter((term) => !normalized.includes(term.toLowerCase()))
      .map((term) => `missing required term: ${term}`),
    ...forbiddenTokens
      .filter((token) => normalized.includes(token.toLowerCase()))
      .map((token) => `repeated forbidden token: ${token}`),
  ];
  if (!response.trim()) reasons.push("empty response");
  return { passed: reasons.length === 0, reasons };
}
