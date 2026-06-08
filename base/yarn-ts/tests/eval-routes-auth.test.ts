import { describe, expect, it, vi } from "vitest";
import { registerEvalRoutes } from "../src/eval/routes.js";
import type { AppConfig } from "../src/config.js";

describe("eval route auth", () => {
  it("uses centralized internal auth denial logging", async () => {
    const warn = vi.fn();
    const routes = new Map<string, RouteRegistration>();
    const app = {
      log: { warn, error: vi.fn() },
      get: vi.fn((path: string, opts: RouteOptions, handler: RouteHandler) => {
        routes.set(path, { opts, handler });
      }),
      post: vi.fn((path: string, opts: RouteOptions, handler: RouteHandler) => {
        routes.set(path, { opts, handler });
      }),
    };

    registerEvalRoutes(app as never, evalConfig(), {
      requireInternalToken: vi.fn(() => false),
    });

    const route = routes.get("/v1/eval/scenarios");
    expect(route).toBeDefined();
    const reply = createReplyProbe();
    await route?.opts.preHandler?.({
      headers: { authorization: "Bearer syn-secret-value" },
      id: "req-eval",
      method: "GET",
      routeOptions: { url: "/v1/eval/scenarios" },
    }, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: { type: "auth_error", message: "Internal service token required" } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/v1/eval/scenarios",
        route: "/v1/eval/scenarios",
        reqId: "req-eval",
        method: "GET",
        authHeaderKind: "syn_pat",
        reason: "internal_service_token_required",
      }),
      "internal_route_auth_denied",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("syn-secret-value");
  });
});

type RouteHandler = (request: unknown, reply: ReplyProbe) => Promise<unknown>;
type RouteOptions = {
  preHandler?: (request: Record<string, unknown>, reply: ReplyProbe) => Promise<void>;
};
type RouteRegistration = {
  opts: RouteOptions;
  handler: RouteHandler;
};

function evalConfig(): AppConfig {
  return {
    SYNESIS_YARN_EVAL_API_ENABLED: true,
    SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:3000/v1",
    SYNESIS_YARN_ADMIN_API_URL: "http://127.0.0.1:8000",
    SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "test-key",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "internal-token",
  } as AppConfig;
}

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
