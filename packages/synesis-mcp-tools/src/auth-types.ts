/**
 * Identity for Synesis MCP tool handlers — derived from validated PAT (or service identity).
 * Never accept these fields from unauthenticated client JSON.
 */
export interface SynesisMcpAuth {
  /** Validated caller credential; reused upstream only by explicit local clients. */
  bearerToken: string;
  userId: string;
  orgId: string;
  tenantIds: string[];
  aclGroups?: string[];
}
