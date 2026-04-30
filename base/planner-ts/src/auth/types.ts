export interface AuthContext {
  userId: string;
  userEmail: string;
  orgId: string;
  tenantIds: string[];
  aclGroups?: string[];
  role: "readonly" | "user" | "org_admin" | "platform_admin";
  tokenScopes: string[];
  authMethod: "anonymous" | "bearer" | "pat" | "internal_service";
  trustedForwardedIdentity: boolean;
}
