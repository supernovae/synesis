import { describe, expect, it, vi } from "vitest";
import { registerHealthRoutes } from "../src/routes/health-routes.js";
import type { PlatformRouteDependencies } from "../src/routes/platform-route-support.js";

describe("health routes", () => {
  it("requires an internal token for metrics", async () => {
    const routes = registerRoutesWithAuth(false);
    const reply = createReplyProbe();
    await routes.get("/metrics")?.({ headers: {} }, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: { type: "auth_error", message: "Internal service token required" } });
  });

  it("returns metrics for internal callers", async () => {
    const routes = registerRoutesWithAuth(true);
    const reply = createReplyProbe();
    const body = await routes.get("/metrics")?.({ headers: { authorization: "Bearer token" } }, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.headers["Content-Type"]).toBe("text/plain; version=0.0.4");
    expect(body).toBe("synesis_metric 1\n");
  });
});

function registerRoutesWithAuth(authorized: boolean): Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>> {
  const routes = new Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>();
  const app = {
    get: vi.fn((path: string, handler: (req: unknown, reply: ReplyProbe) => Promise<unknown>) => {
      routes.set(path, handler);
    }),
  };
  const deps = {
    app,
    usagePersistenceEnabled: false,
    usageWriter: { getStats: () => ({}) },
    sessionStore: { ping: async () => true },
    promRegistry: {
      contentType: "text/plain; version=0.0.4",
      metrics: async () => "synesis_metric 1\n",
    },
    requireInternalToken: vi.fn(() => authorized),
  } as unknown as PlatformRouteDependencies;

  registerHealthRoutes(deps);
  return routes;
}

interface ReplyProbe {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  code(statusCode: number): ReplyProbe;
  header(name: string, value: string): ReplyProbe;
  send(body: unknown): unknown;
}

function createReplyProbe(): ReplyProbe {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    header(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return body;
    },
  };
}
