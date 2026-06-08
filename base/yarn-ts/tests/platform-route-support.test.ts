import { describe, expect, it, vi } from "vitest";

import { authRejectionLogFields, requireInternalRouteToken } from "../src/routes/platform-route-support.js";

describe("platform route auth diagnostics", () => {
  it("classifies double Bearer PAT headers without exposing token material", () => {
    const fields = authRejectionLogFields(
      new Error("Malformed Authorization header: configure API key as the raw syn- token"),
      "Bearer Bearer syn-secret-value",
      "/v1/chat/completions",
    );

    expect(fields).toMatchObject({
      endpoint: "/v1/chat/completions",
      authHeaderKind: "double_bearer_syn_pat",
    });
    expect(JSON.stringify(fields)).not.toContain("syn-secret-value");
  });

  it("classifies quoted PAT headers without exposing token material", () => {
    const fields = authRejectionLogFields(
      new Error("Malformed Authorization header: token value is quoted"),
      'Bearer "syn-secret-value"',
      "/v1/chat/completions",
    );

    expect(fields).toMatchObject({
      endpoint: "/v1/chat/completions",
      authHeaderKind: "quoted_syn_pat",
    });
    expect(JSON.stringify(fields)).not.toContain("syn-secret-value");
  });

  it("logs internal route auth denials without exposing token material", () => {
    const warn = vi.fn();
    const reply = createReplyProbe();
    const allowed = requireInternalRouteToken(
      {
        app: { log: { warn } },
        requireInternalToken: vi.fn(() => false),
      } as never,
      {
        headers: { authorization: "Bearer syn-secret-value" },
        id: "req-1",
        method: "GET",
      },
      reply,
      "/metrics",
    );

    expect(allowed).toBe(false);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: { type: "auth_error", message: "Internal service token required" } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/metrics",
        route: "/metrics",
        reqId: "req-1",
        method: "GET",
        authHeaderKind: "syn_pat",
        reason: "internal_service_token_required",
      }),
      "internal_route_auth_denied",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("syn-secret-value");
  });
});

interface ReplyProbe {
  statusCode: number;
  body: unknown;
  code(statusCode: number): ReplyProbe;
  send(body: unknown): unknown;
}

function createReplyProbe(): ReplyProbe {
  return {
    statusCode: 200,
    body: undefined,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return body;
    },
  };
}
