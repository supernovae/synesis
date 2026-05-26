export type InternalTokenRequest = {
  headers: Record<string, unknown>;
};

export function getBearerToken(authHeader: string | undefined): string {
  const raw = authHeader ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

export function createInternalTokenRequirement(
  internalServiceToken: string | undefined,
): (req: InternalTokenRequest) => boolean {
  return (req: InternalTokenRequest): boolean => {
    if (!internalServiceToken) return false;
    const bearer = getBearerToken(req.headers.authorization as string | undefined);
    return bearer === internalServiceToken;
  };
}
