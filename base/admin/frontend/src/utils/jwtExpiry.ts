/**
 * Read JWT `exp` (seconds since epoch) for client-side refresh scheduling only.
 * Does not verify the signature.
 */
export function readJwtExpMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) return null;
  try {
    const body = parts[1];
    if (!body) return null;
    const json = body.replace(/-/g, "+").replace(/_/g, "/");
    const padded = json + "===".slice((json.length + 3) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** Prefer OAuth `expires_in`; fall back to JWT `exp` when absent. */
export function resolveAccessTokenExpiresAtMs(
  accessToken: string,
  expiresIn?: number,
): number | null {
  if (typeof expiresIn === "number" && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }
  return readJwtExpMs(accessToken);
}
