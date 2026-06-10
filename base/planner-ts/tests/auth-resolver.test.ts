import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { resolveAuthContext } from "../src/auth/resolver.js";
import { loadConfig } from "../src/config.js";

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as FastifyRequest;
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    SYNESIS_WEB_SEARCH_ENABLED: "false",
    SYNESIS_WEB_SEARCH_URL: "",
    ...overrides,
  });
}

describe("resolveAuthContext", () => {
  it("fails closed when production planner auth is not enabled", () => {
    expect(() => config({ NODE_ENV: "production", SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false" })).toThrow(
      /SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH/,
    );
  });

  it("rejects opaque bearer tokens by default", async () => {
    await expect(
      resolveAuthContext(
        request({ authorization: "Bearer arbitrary-token" }),
        config({ SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true" }),
      ),
    ).rejects.toThrow(/Opaque bearer authentication is disabled/);
  });

  it("does not trust caller-provided scopes for opaque bearer compatibility", async () => {
    const auth = await resolveAuthContext(
      request({
        authorization: "Bearer arbitrary-token",
        "x-synesis-token-scopes": "admin:write,coder:execute",
      }),
      config({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER: "true",
      }),
    );
    expect(auth.authMethod).toBe("bearer");
    expect(auth.trustedForwardedIdentity).toBe(false);
    expect(auth.tokenScopes).toEqual(["model:readonly"]);
  });

  it("trusts forwarded scopes only with the internal service token", async () => {
    const auth = await resolveAuthContext(
      request({
        authorization: "Bearer internal-token",
        "x-openwebui-user-id": "forwarded-user",
        "x-synesis-token-scopes": "model:readonly,coder:execute",
      }),
      config({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-token",
      }),
    );
    expect(auth.authMethod).toBe("internal_service");
    expect(auth.trustedForwardedIdentity).toBe(true);
    expect(auth.tokenScopes).toEqual(["model:readonly", "coder:execute"]);
  });

  it("does not enter forwarded identity mode for internal service requests without forwarded headers", async () => {
    const auth = await resolveAuthContext(
      request({
        authorization: "Bearer internal-token",
      }),
      config({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-token",
      }),
    );
    expect(auth.authMethod).toBe("internal_service");
    expect(auth.userId).toBe("planner-internal");
    expect(auth.trustedForwardedIdentity).toBe(false);
    expect(auth.tokenScopes).toEqual(["model:readonly"]);
  });

  it("defaults trusted forwarded identity to model scope when Open WebUI sends no scope header", async () => {
    const auth = await resolveAuthContext(
      request({
        authorization: "Bearer internal-token",
        "x-openwebui-user-id": "forwarded-user",
        "x-openwebui-user-email": "forwarded@example.com",
      }),
      config({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-token",
      }),
    );
    expect(auth.authMethod).toBe("internal_service");
    expect(auth.userId).toBe("forwarded-user");
    expect(auth.trustedForwardedIdentity).toBe(true);
    expect(auth.tokenScopes).toEqual(["model:readonly"]);
  });

  it("rejects untrusted malformed forwarded identity headers in strict mode", async () => {
    await expect(
      resolveAuthContext(
        request({
          authorization: "Bearer arbitrary-token",
          "x-openwebui-user-id": "spoofed user",
          "x-synesis-token-scopes": "model:readonly,role override",
        }),
        config({
          SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
          SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER: "true",
          SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
          SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
          SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-token",
        }),
      ),
    ).rejects.toMatchObject({ message: "Untrusted forwarded identity headers", statusCode: 403 });
  });

  it("rejects malformed trusted forwarded identity headers with a validation status", async () => {
    await expect(
      resolveAuthContext(
        request({
          authorization: "Bearer internal-token",
          "x-openwebui-user-id": "trusted-user",
          "x-synesis-token-scopes": "model:readonly,role override",
        }),
        config({
          SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
          SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
          SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
          SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-token",
        }),
      ),
    ).rejects.toMatchObject({ message: "invalid_token_scopes", statusCode: 400 });
  });

  it("accepts internal service tokens without trusting forwarded identity headers", async () => {
    const auth = await resolveAuthContext(
      request({ authorization: "Bearer internal-token" }),
      config({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-token",
      }),
    );
    expect(auth.authMethod).toBe("internal_service");
    expect(auth.trustedForwardedIdentity).toBe(false);
    expect(auth.tokenScopes).toEqual(["model:readonly"]);
  });
});
