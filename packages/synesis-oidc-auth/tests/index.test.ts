import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { OidcAuthError, OidcTokenVerifier } from "../src/index.js";

const nowSeconds = 1_800_000_000;

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}

function signJwt(privateKey: crypto.KeyObject, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key", ...header })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifier(jwk: JsonWebKey, overrides: Partial<ConstructorParameters<typeof OidcTokenVerifier>[0]> = {}) {
  return new OidcTokenVerifier({
    issuerUrl: "https://auth.example.com/realms/synesis",
    internalIssuerUrl: "http://keycloak.synesis-auth.svc/realms/synesis",
    allowedClientIds: ["synesis-harness"],
    requiredRoles: ["synesis-user"],
    nowMs: () => nowSeconds * 1000,
    fetchImpl: async (url) => {
      expect(String(url)).toBe("http://keycloak.synesis-auth.svc/realms/synesis/protocol/openid-connect/certs");
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    ...overrides,
  });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://auth.example.com/realms/synesis",
    sub: "user-123",
    exp: nowSeconds + 600,
    azp: "synesis-harness",
    preferred_username: "pi-user",
    email: "pi-user@example.com",
    scope: "openid profile email",
    realm_access: { roles: ["synesis-user"] },
    organization: {
      "org-1": { name: "Org One", roles: ["admin"] },
    },
    ...overrides,
  };
}

describe("OidcTokenVerifier", () => {
  it("verifies RS256 Keycloak-style OIDC tokens", async () => {
    const { privateKey, jwk } = keyPair();
    const token = signJwt(privateKey, validPayload());

    const principal = await verifier(jwk).verify(token);

    expect(principal.userId).toBe("user-123");
    expect(principal.clientId).toBe("synesis-harness");
    expect(principal.email).toBe("pi-user@example.com");
    expect(principal.realmRoles).toEqual(["synesis-user"]);
    expect(principal.orgId).toBe("org-1");
    expect(principal.orgRoles).toEqual(["admin"]);
  });

  it("rejects tokens issued for a different client", async () => {
    const { privateKey, jwk } = keyPair();
    const token = signJwt(privateKey, validPayload({ azp: "synesis-admin" }));

    await expect(verifier(jwk).verify(token)).rejects.toMatchObject({
      code: "invalid_client",
    } satisfies Partial<OidcAuthError>);
  });

  it("accepts standard aud client claims when azp is absent", async () => {
    const { privateKey, jwk } = keyPair();
    const token = signJwt(privateKey, validPayload({ azp: undefined, aud: ["synesis-harness"] }));

    const principal = await verifier(jwk).verify(token);

    expect(principal.clientId).toBe("synesis-harness");
  });

  it("rejects missing required roles", async () => {
    const { privateKey, jwk } = keyPair();
    const token = signJwt(privateKey, validPayload({ realm_access: { roles: ["offline_access"] } }));

    await expect(verifier(jwk).verify(token)).rejects.toMatchObject({
      code: "missing_required_role",
    } satisfies Partial<OidcAuthError>);
  });

  it("rejects expired tokens", async () => {
    const { privateKey, jwk } = keyPair();
    const token = signJwt(privateKey, validPayload({ exp: nowSeconds - 120 }));

    await expect(verifier(jwk).verify(token)).rejects.toMatchObject({
      code: "token_expired",
    } satisfies Partial<OidcAuthError>);
  });
});
