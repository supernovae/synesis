import { describe, expect, it } from "vitest";
import { getKeycloakRealmName, resolveKeycloakRealmIssuer } from "./keycloakUrls";

describe("resolveKeycloakRealmIssuer", () => {
  it("preserves issuer when it already points at a realm", () => {
    expect(resolveKeycloakRealmIssuer("https://auth.kybern.dev/realms/synesis")).toBe(
      "https://auth.kybern.dev/realms/synesis",
    );
  });

  it("preserves auth-prefix deployments", () => {
    expect(resolveKeycloakRealmIssuer("https://auth.kybern.dev/auth/realms/synesis")).toBe(
      "https://auth.kybern.dev/auth/realms/synesis",
    );
  });

  it("rewrites admin-console URLs to synesis realm", () => {
    expect(resolveKeycloakRealmIssuer("https://auth.kybern.dev/admin/master/console")).toBe(
      "https://auth.kybern.dev/realms/synesis",
    );
    expect(resolveKeycloakRealmIssuer("https://auth.kybern.dev/auth/admin/master/console")).toBe(
      "https://auth.kybern.dev/auth/realms/synesis",
    );
  });

  it("fills in the default realm when issuer has no realm segment", () => {
    expect(resolveKeycloakRealmIssuer("https://auth.kybern.dev")).toBe(
      "https://auth.kybern.dev/realms/synesis",
    );
  });

  it("returns null for malformed issuer", () => {
    expect(resolveKeycloakRealmIssuer("not-a-url")).toBeNull();
    expect(resolveKeycloakRealmIssuer("")).toBeNull();
  });
});

describe("getKeycloakRealmName", () => {
  it("reads realm from issuer", () => {
    expect(getKeycloakRealmName("https://auth.kybern.dev/realms/synesis")).toBe("synesis");
    expect(getKeycloakRealmName("https://auth.kybern.dev/realms/engineering")).toBe(
      "engineering",
    );
  });

  it("falls back to default realm", () => {
    expect(getKeycloakRealmName("")).toBe("synesis");
  });
});
