import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { AuthContext } from "./types.js";

function parseBearerToken(request: FastifyRequest): string {
  const raw = String(request.headers.authorization ?? "");
  if (!raw.startsWith("Bearer ")) return "";
  return raw.slice(7).trim();
}

function parseCsvHeader(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function hasForwardedIdentityHeaders(request: FastifyRequest): boolean {
  const keys = [
    "x-openwebui-user-id",
    "x-openwebui-user-email",
    "x-synesis-org-id",
    "x-synesis-tenant-ids"
  ];
  return keys.some((key) => {
    const value = request.headers[key];
    if (!value) return false;
    return String(Array.isArray(value) ? value[0] : value).trim().length > 0;
  });
}

export function resolveAuthContext(request: FastifyRequest, config: AppConfig): AuthContext {
  const token = parseBearerToken(request);
  const forwardedPresent = hasForwardedIdentityHeaders(request);

  if (config.SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH && !token) {
    throw new Error("Missing Bearer token");
  }

  const trustedForwarded =
    Boolean(config.SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS) &&
    token.length > 0 &&
    token === config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;

  if (
    forwardedPresent &&
    config.SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE &&
    !trustedForwarded
  ) {
    const err = new Error("Untrusted forwarded identity headers");
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }

  const tenantIdsFromHeader = parseCsvHeader(request.headers["x-synesis-tenant-ids"]);
  const scopeHeader = parseCsvHeader(request.headers["x-synesis-token-scopes"]);

  if (trustedForwarded) {
    return {
      userId: String(request.headers["x-openwebui-user-id"] ?? "forwarded-user"),
      orgId: String(request.headers["x-synesis-org-id"] ?? ""),
      tenantIds: tenantIdsFromHeader,
      role: "user",
      tokenScopes: scopeHeader.length > 0 ? scopeHeader : ["model:readonly"],
      authMethod: "internal_service",
      trustedForwardedIdentity: true
    };
  }

  if (!token) {
    return {
      userId: "anonymous",
      orgId: "",
      tenantIds: [],
      role: "readonly",
      tokenScopes: [],
      authMethod: "anonymous",
      trustedForwardedIdentity: false
    };
  }

  if (token.startsWith("syn-")) {
    return {
      userId: "pat-user",
      orgId: "",
      tenantIds: tenantIdsFromHeader,
      role: "user",
      tokenScopes: scopeHeader.length > 0 ? scopeHeader : ["model:readonly"],
      authMethod: "pat",
      trustedForwardedIdentity: false
    };
  }

  return {
    userId: "bearer-user",
    orgId: "",
    tenantIds: tenantIdsFromHeader,
    role: "user",
    tokenScopes: scopeHeader,
    authMethod: "bearer",
    trustedForwardedIdentity: false
  };
}
