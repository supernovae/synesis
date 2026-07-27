import { describe, expect, it, vi } from "vitest";

import { sandboxAuthorization, signServiceRequest } from "../src/security/service-auth.js";

describe("service request auth", () => {
  it("matches the shared HMAC wire format", () => {
    expect(signServiceRequest("{}", "secret", "0123456789abcdef0123456789abcdef", 123)).toBe(
      "Bearer HMAC-SHA256:e9f6b7c54adca860b6ae4b1c9de851abe7a1058431005853355d3591cd793fa6:123:0123456789abcdef0123456789abcdef",
    );
  });

  it("obtains and signs a server challenge", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nonce: "0123456789abcdef0123456789abcdef" }),
    }));
    await expect(sandboxAuthorization("http://sandbox:8080/execute", "{}", "secret"))
      .resolves.toMatch(/^Bearer HMAC-SHA256:/);
    vi.unstubAllGlobals();
  });

  it("fails without a secret", async () => {
    await expect(sandboxAuthorization("http://sandbox:8080/execute", "{}", "")).rejects.toThrow("not configured");
  });
});
