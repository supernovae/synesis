import type { SynesisPrincipal } from "@synesis/auth-contracts";

type PlannerAuthMethod = "anonymous" | "bearer" | "pat" | "internal_service";
type PlannerRole = "readonly" | "user" | "org_admin" | "platform_admin";

export interface AuthContext extends Omit<SynesisPrincipal, "authMethod" | "role" | "userEmail" | "trustedForwardedIdentity"> {
  authMethod: PlannerAuthMethod;
  role: PlannerRole;
  userEmail: string;
  trustedForwardedIdentity: boolean;
}
