import crypto from "node:crypto";

export type OidcAuthErrorCode =
  | "oidc_not_configured"
  | "malformed_token"
  | "unsupported_alg"
  | "jwks_fetch_failed"
  | "signing_key_not_found"
  | "invalid_signature"
  | "invalid_issuer"
  | "token_expired"
  | "token_not_yet_valid"
  | "invalid_client"
  | "missing_required_role"
  | "invalid_claims";

export class OidcAuthError extends Error {
  readonly code: OidcAuthErrorCode;

  constructor(code: OidcAuthErrorCode, message: string) {
    super(message);
    this.name = "OidcAuthError";
    this.code = code;
  }
}

export interface OidcVerifierConfig {
  issuerUrl: string;
  internalIssuerUrl?: string;
  allowedClientIds?: string[];
  requiredRoles?: string[];
  jwksCacheTtlMs?: number;
  clockSkewSeconds?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export interface OidcVerifiedPrincipal {
  userId: string;
  issuer: string;
  clientId: string;
  username: string;
  email: string;
  displayName?: string;
  realmRoles: string[];
  orgId: string;
  orgName: string;
  orgRoles: string[];
  scopes: string[];
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface JwtPayload {
  iss?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  aud?: unknown;
  azp?: unknown;
  client_id?: unknown;
  preferred_username?: unknown;
  email?: unknown;
  scope?: unknown;
  realm_access?: unknown;
  organization?: unknown;
}

interface JsonWebKeySet {
  keys?: SynesisJsonWebKey[];
}

type SynesisJsonWebKey = JsonWebKey & { kid?: string; alg?: string; use?: string };

function normalizeUrl(value: string): string {
  let url = value.trim();
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function cleanList(values: string[] | undefined, fallback: string[] = []): string[] {
  const out = (values ?? fallback)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(out)];
}

function decodeJsonSegment<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch (_err) {
    throw new OidcAuthError("malformed_token", "OIDC token contains malformed JSON") as never;
  }
}

function numberClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayStringClaim(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function splitScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

function audienceValues(value: unknown): string[] {
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  return arrayStringClaim(value);
}

function realmRoles(payload: JwtPayload): string[] {
  const realmAccess = payload.realm_access;
  if (!realmAccess || typeof realmAccess !== "object" || Array.isArray(realmAccess)) return [];
  return arrayStringClaim((realmAccess as Record<string, unknown>).roles);
}

function parseOrganization(payload: JwtPayload): { orgId: string; orgName: string; orgRoles: string[] } {
  const orgClaim = payload.organization;
  if (!orgClaim || typeof orgClaim !== "object" || Array.isArray(orgClaim)) {
    return { orgId: "", orgName: "", orgRoles: [] };
  }
  const entries = Object.entries(orgClaim as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => {
      const value = entry[1];
      return Boolean(value && typeof value === "object" && !Array.isArray(value));
    });
  if (entries.length !== 1) return { orgId: "", orgName: "", orgRoles: [] };
  const [orgId, orgData] = entries[0]!;
  return {
    orgId: orgId.trim(),
    orgName: stringClaim(orgData.name),
    orgRoles: arrayStringClaim(orgData.roles),
  };
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export class OidcTokenVerifier {
  private readonly issuerUrl: string;
  private readonly jwksBaseUrl: string;
  private readonly allowedClientIds: string[];
  private readonly requiredRoles: string[];
  private readonly jwksCacheTtlMs: number;
  private readonly clockSkewSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private jwks: JsonWebKeySet | null = null;
  private jwksFetchedAt = 0;

  constructor(config: OidcVerifierConfig) {
    this.issuerUrl = normalizeUrl(config.issuerUrl);
    this.jwksBaseUrl = normalizeUrl(config.internalIssuerUrl || config.issuerUrl);
    this.allowedClientIds = cleanList(config.allowedClientIds, ["synesis-harness"]);
    this.requiredRoles = cleanList(config.requiredRoles, ["synesis-user", "synesis-org-admin", "synesis-admin"]);
    this.jwksCacheTtlMs = Math.max(1_000, config.jwksCacheTtlMs ?? 300_000);
    this.clockSkewSeconds = Math.max(0, config.clockSkewSeconds ?? 60);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.nowMs = config.nowMs ?? (() => Date.now());
    if (!this.issuerUrl) {
      throw new OidcAuthError("oidc_not_configured", "OIDC issuer is not configured");
    }
  }

  async verify(token: string): Promise<OidcVerifiedPrincipal> {
    const parts = token.trim().split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw new OidcAuthError("malformed_token", "OIDC bearer token must be a compact JWT");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJsonSegment<JwtHeader>(encodedHeader);
    const payload = decodeJsonSegment<JwtPayload>(encodedPayload);
    if (header.alg !== "RS256") {
      throw new OidcAuthError("unsupported_alg", "Only RS256 OIDC tokens are accepted");
    }
    const kid = stringClaim(header.kid);
    if (!kid) {
      throw new OidcAuthError("signing_key_not_found", "OIDC token header is missing kid");
    }
    const key = await this.getSigningKey(kid);
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    const ok = verifier.verify(crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(encodedSignature, "base64url"));
    if (!ok) {
      throw new OidcAuthError("invalid_signature", "OIDC token signature verification failed");
    }
    return this.verifyClaims(payload);
  }

  private async getSigningKey(kid: string): Promise<SynesisJsonWebKey> {
    const jwks = await this.getJwks();
    const key = (jwks.keys ?? []).find((candidate) => candidate.kid === kid);
    if (!key) {
      this.jwks = null;
      const refreshed = await this.getJwks();
      const refreshedKey = (refreshed.keys ?? []).find((candidate) => candidate.kid === kid);
      if (refreshedKey) return refreshedKey;
      throw new OidcAuthError("signing_key_not_found", "OIDC signing key not found in JWKS");
    }
    return key;
  }

  private async getJwks(): Promise<JsonWebKeySet> {
    const now = this.nowMs();
    if (this.jwks && now - this.jwksFetchedAt < this.jwksCacheTtlMs) return this.jwks;
    const jwksUrl = `${this.jwksBaseUrl}/protocol/openid-connect/certs`;
    let response: Response;
    try {
      response = await this.fetchImpl(jwksUrl, { signal: AbortSignal.timeout(5_000) });
    } catch (_err) {
      throw new OidcAuthError("jwks_fetch_failed", "Could not fetch OIDC JWKS") as never;
    }
    if (!response.ok) {
      throw new OidcAuthError("jwks_fetch_failed", `OIDC JWKS returned HTTP ${response.status}`);
    }
    const raw = await response.json() as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as JsonWebKeySet).keys)) {
      throw new OidcAuthError("jwks_fetch_failed", "OIDC JWKS response is malformed");
    }
    this.jwks = raw as JsonWebKeySet;
    this.jwksFetchedAt = now;
    return this.jwks;
  }

  private verifyClaims(payload: JwtPayload): OidcVerifiedPrincipal {
    const issuer = stringClaim(payload.iss);
    if (!timingSafeEqualString(issuer, this.issuerUrl)) {
      throw new OidcAuthError("invalid_issuer", "OIDC token issuer does not match configured issuer");
    }
    const nowSeconds = Math.floor(this.nowMs() / 1000);
    const exp = numberClaim(payload.exp);
    if (!exp) throw new OidcAuthError("invalid_claims", "OIDC token is missing exp");
    if (exp + this.clockSkewSeconds < nowSeconds) {
      throw new OidcAuthError("token_expired", "OIDC token has expired");
    }
    const nbf = numberClaim(payload.nbf);
    if (nbf && nbf - this.clockSkewSeconds > nowSeconds) {
      throw new OidcAuthError("token_not_yet_valid", "OIDC token is not yet valid");
    }
    const sub = stringClaim(payload.sub);
    if (!sub) throw new OidcAuthError("invalid_claims", "OIDC token is missing sub");

    const audiences = audienceValues(payload.aud);
    const clientId = stringClaim(payload.azp)
      || stringClaim(payload.client_id)
      || audiences.find((audience) => this.allowedClientIds.includes(audience))
      || "";
    if (!clientId || !this.allowedClientIds.includes(clientId)) {
      throw new OidcAuthError("invalid_client", "OIDC token client is not allowed for harness access");
    }
    const roles = realmRoles(payload);
    if (this.requiredRoles.length > 0 && !roles.some((role) => this.requiredRoles.includes(role))) {
      throw new OidcAuthError("missing_required_role", "OIDC token is missing a required Synesis role");
    }
    const org = parseOrganization(payload);
    const email = stringClaim(payload.email).slice(0, 256);
    const username = stringClaim(payload.preferred_username) || email || sub;
    return {
      userId: sub,
      issuer,
      clientId,
      username,
      email,
      displayName: email || username,
      realmRoles: roles,
      orgId: org.orgId,
      orgName: org.orgName,
      orgRoles: org.orgRoles,
      scopes: splitScopes(payload.scope),
    };
  }
}

export function createOidcVerifierFromEnv(env: {
  issuerUrl?: string;
  internalIssuerUrl?: string;
  allowedClientIds?: string;
  requiredRoles?: string;
  jwksCacheTtlMs?: number;
  fetchImpl?: typeof fetch;
}): OidcTokenVerifier | null {
  const issuerUrl = env.issuerUrl?.trim();
  if (!issuerUrl) return null;
  const config: OidcVerifierConfig = {
    issuerUrl,
  };
  if (env.internalIssuerUrl !== undefined) config.internalIssuerUrl = env.internalIssuerUrl;
  if (env.allowedClientIds !== undefined) config.allowedClientIds = env.allowedClientIds.split(",");
  if (env.requiredRoles !== undefined) config.requiredRoles = env.requiredRoles.split(",");
  if (env.jwksCacheTtlMs !== undefined) config.jwksCacheTtlMs = env.jwksCacheTtlMs;
  if (env.fetchImpl !== undefined) config.fetchImpl = env.fetchImpl;
  return new OidcTokenVerifier(config);
}
