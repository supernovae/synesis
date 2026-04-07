export interface AcpEnvelope {
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export function validateAcpEnvelope(input: unknown): { ok: boolean; reason?: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "envelope_not_object" };
  const row = input as AcpEnvelope;
  if (!row.id || typeof row.id !== "string") return { ok: false, reason: "missing_id" };
  if (!row.type || typeof row.type !== "string") return { ok: false, reason: "missing_type" };
  return { ok: true };
}

export function acpShouldRetry(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 408 || (statusCode >= 500 && statusCode < 600);
}
