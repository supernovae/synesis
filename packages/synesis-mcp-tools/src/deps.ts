import { z } from "zod";

export const SynesisMcpDepsSchema = z.object({
  plannerBaseUrl: z.string(),
  /** Dedicated credential for MCP/Yarn → planner service calls. */
  internalServiceToken: z.string().optional(),
  /** Local stdio/package clients may use their Synesis PAT at the same platform origin. */
  allowClientTokenFallback: z.boolean().optional(),
});

export type SynesisMcpDeps = z.infer<typeof SynesisMcpDepsSchema>;

export function bearerForUpstream(auth: { bearerToken: string }, deps: SynesisMcpDeps): string {
  const serviceToken = (deps.internalServiceToken ?? "").trim();
  if (serviceToken) return serviceToken;
  return deps.allowClientTokenFallback ? auth.bearerToken.trim() : "";
}

export function authHeaders(bearer: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (bearer.trim()) {
    h.Authorization = `Bearer ${bearer.trim()}`;
  }
  return h;
}

/**
 * Authenticate the MCP → planner hop without passing a client token across
 * resource audiences. Local stdio/package clients can explicitly opt into
 * same-origin PAT reuse; hosted callers fail closed when the service token is
 * missing. Trusted identity headers are added only to service-authenticated
 * requests.
 */
export function upstreamAuthHeaders(
  auth: {
    bearerToken: string;
    userId: string;
    orgId: string;
    tenantIds: string[];
    aclGroups?: string[];
  },
  deps: SynesisMcpDeps,
): Record<string, string> {
  const serviceToken = (deps.internalServiceToken ?? "").trim();
  const headers = authHeaders(serviceToken || (deps.allowClientTokenFallback ? auth.bearerToken : ""));
  if (!serviceToken) return headers;

  if (auth.userId.trim()) headers["x-openwebui-user-id"] = auth.userId.trim();
  if (auth.orgId.trim()) headers["x-synesis-org-id"] = auth.orgId.trim();
  const tenantIds = auth.tenantIds.map((value) => value.trim()).filter(Boolean).slice(0, 50);
  if (tenantIds.length > 0) headers["x-synesis-tenant-ids"] = tenantIds.join(",");
  const aclGroups = (auth.aclGroups ?? []).map((value) => value.trim()).filter(Boolean).slice(0, 100);
  if (aclGroups.length > 0) headers["x-synesis-acl-groups"] = aclGroups.join(",");
  return headers;
}
