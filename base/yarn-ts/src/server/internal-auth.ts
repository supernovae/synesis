import { constantTimeBearerMatch, extractBearerToken } from "@synesis/auth-contracts";

export type InternalTokenRequest = {
  headers: Record<string, unknown>;
};

export function getBearerToken(authHeader: string | undefined): string {
  return extractBearerToken(authHeader);
}

export function createInternalTokenRequirement(
  internalServiceToken: string | undefined,
): (req: InternalTokenRequest) => boolean {
  return (req: InternalTokenRequest): boolean => {
    return constantTimeBearerMatch(req.headers.authorization as string | undefined, internalServiceToken);
  };
}
