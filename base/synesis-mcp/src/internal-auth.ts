import { constantTimeBearerMatch } from "@synesis/auth-contracts";

export function requireInternalBearer(authorizationHeader: string | undefined, internalServiceToken: string): boolean {
  const token = internalServiceToken.trim();
  if (!token) return false;
  return constantTimeBearerMatch(authorizationHeader, token);
}
