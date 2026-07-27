import { createHash, createHmac } from "node:crypto";

export function signServiceRequest(
  body: string,
  secret: string,
  nonce: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret).update(`${timestamp}:${nonce}:${bodyHash}`).digest("hex");
  return `Bearer HMAC-SHA256:${signature}:${timestamp}:${nonce}`;
}

export async function sandboxAuthorization(url: string, body: string, secret: string): Promise<string> {
  if (!secret) throw new Error("Sandbox authentication is not configured");
  const response = await fetch(new URL("/auth/challenge", url), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Sandbox challenge returned HTTP ${response.status}`);
  const challenge = await response.json() as { nonce?: unknown };
  if (typeof challenge.nonce !== "string" || !/^[a-f0-9]{32}$/.test(challenge.nonce)) {
    throw new Error("Sandbox returned an invalid authentication challenge");
  }
  return signServiceRequest(body, secret, challenge.nonce);
}
