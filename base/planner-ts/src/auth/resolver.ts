import type { FastifyRequest } from "fastify";
import {
  buildForwardedIdentityPrincipal,
  constantTimeStringMatch,
  extractBearerToken,
  hasForwardedIdentityHeaders,
  parseForwardedIdentityHeaders,
  stableOpaqueBearerUserId,
  type HeaderMap,
} from "@synesis/auth-contracts";
import type { AppConfig } from "../config.js";
import type { AuthContext } from "./types.js";
import { resolvePatFromDb } from "./pat-resolver.js";

function parseBearerToken(request: FastifyRequest): string {
  const raw = request.headers.authorization;
  return extractBearerToken(Array.isArray(raw) ? raw[0] : raw);
}

export async function resolveAuthContext(request: FastifyRequest, config: AppConfig): Promise<AuthContext> {
  const token = parseBearerToken(request);
  const forwarded = parseForwardedIdentityHeaders(request.headers as HeaderMap);

  if (config.SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH && !token) {
    throw new Error("Missing Bearer token");
  }

  const internalTokenMatch = constantTimeStringMatch(token, config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN);
  const trustedForwarded =
    Boolean(config.SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS) &&
    internalTokenMatch;

  if (
    hasForwardedIdentityHeaders(request.headers as HeaderMap) &&
    config.SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE &&
    !trustedForwarded
  ) {
    const err = new Error("Untrusted forwarded identity headers");
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }

  if (trustedForwarded) {
    const principal = buildForwardedIdentityPrincipal(forwarded, ["model:readonly"]);
    return {
      ...principal,
      authMethod: "internal_service",
      role: "user",
      userEmail: principal.userEmail ?? "",
      trustedForwardedIdentity: true,
    };
  }

  if (internalTokenMatch) {
    return {
      userId: "planner-internal",
      userEmail: "",
      orgId: "",
      tenantIds: [],
      role: "user",
      tokenScopes: ["model:readonly"],
      authMethod: "internal_service",
      authKeyId: "internal-service",
      authKeyName: "Internal service",
      authKeyPrefix: "internal",
      trustedForwardedIdentity: false
    };
  }

  if (!token) {
    return {
      userId: "anonymous",
      userEmail: "",
      orgId: "",
      tenantIds: [],
      role: "readonly",
      tokenScopes: config.SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH ? [] : ["model:readonly"],
      authMethod: "anonymous",
      authKeyId: "anonymous",
      authKeyName: "Anonymous",
      authKeyPrefix: "anonymous",
      trustedForwardedIdentity: false
    };
  }

  if (token.startsWith("syn-")) {
    const pat = await resolvePatFromDb(token, config.SYNESIS_PAT_PEPPER);
    if (!pat) {
      const err = new Error("Invalid token");
      (err as Error & { statusCode?: number }).statusCode = 401;
      throw err;
    }
    return {
      userId: pat.userId,
      userEmail: "",
      orgId: pat.orgId,
      tenantIds: pat.tenantIds,
      role: pat.role as AuthContext["role"],
      tokenScopes: pat.scopes,
      authMethod: "pat",
      authKeyId: pat.id,
      authKeyName: pat.name,
      authKeyPrefix: pat.tokenPrefix,
      trustedForwardedIdentity: false
    };
  }

  if (!config.SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER) {
    const err = new Error("Opaque bearer authentication is disabled");
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }

  const bearerKeyId = stableOpaqueBearerUserId(token);

  return {
    userId: bearerKeyId,
    userEmail: "",
    orgId: "",
    tenantIds: [],
    role: "user",
    tokenScopes: ["model:readonly"],
    authMethod: "bearer",
    authKeyId: bearerKeyId,
    authKeyName: "External bearer token",
    authKeyPrefix: "bearer",
    trustedForwardedIdentity: false
  };
}
