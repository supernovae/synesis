/**
 * Identity for Synesis MCP tool handlers — derived from validated PAT (or service identity).
 * Never accept these fields from unauthenticated client JSON.
 */
export interface SynesisMcpAuth {
  /** Bearer token to send to planner/critic (PAT or internal service token). */
  bearerToken: string;
  userId: string;
  orgId: string;
  tenantIds: string[];
  aclGroups?: string[];
}
