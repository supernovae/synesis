import { z } from "zod";

export const SynesisMcpDepsSchema = z.object({
  plannerBaseUrl: z.string(),
  criticUrl: z.string(),
  criticModel: z.string(),
  /** Fallback when no user PAT is present (cluster-internal only). */
  internalServiceToken: z.string().optional(),
});

export type SynesisMcpDeps = z.infer<typeof SynesisMcpDepsSchema>;

export function bearerForUpstream(auth: { bearerToken: string }, deps: SynesisMcpDeps): string {
  const u = auth.bearerToken.trim();
  if (u) return u;
  return (deps.internalServiceToken ?? "").trim();
}

export function authHeaders(bearer: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (bearer.trim()) {
    h.Authorization = `Bearer ${bearer.trim()}`;
  }
  return h;
}
