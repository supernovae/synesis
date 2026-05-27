import { describe, expect, it, vi } from "vitest";
import { registerTelemetryRoutes } from "../src/routes/telemetry-routes.js";
import type { PlatformRouteDependencies } from "../src/routes/platform-route-support.js";

describe("telemetry routes", () => {
  it("degrades missing transitional stats dependencies instead of throwing", async () => {
    const routes = new Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>();
    const app = {
      get: vi.fn((path: string, handler: (req: unknown, reply: ReplyProbe) => Promise<unknown>) => {
        routes.set(path, handler);
      }),
    };
    const deps = {
      app,
      config: {},
      authResolver: {},
      requireInternalToken: vi.fn(() => true),
      sessions: [],
      diagnosticRegistry: undefined,
      usageWriter: undefined,
      validationNormalization: undefined,
      toolResultReduction: undefined,
      transcriptPruning: undefined,
      contentDedupBySession: undefined,
      contextAdmissionStats: undefined,
      promptSnapshotRegistry: null,
      governanceClient: null,
      yarnToolPrefixCache: null,
    } as unknown as PlatformRouteDependencies;

    registerTelemetryRoutes(deps);

    const reply = createReplyProbe();
    const body = await routes.get("/health/telemetry")?.({ headers: {} }, reply) as Record<string, unknown>;

    expect(reply.statusCode).toBe(200);
    expect(body.writeQueue).toMatchObject({ available: false, name: "usageWriter" });
    expect(body.validationNormalization).toMatchObject({ available: false, name: "validationNormalization" });
    expect(body.compressionEfficiencyIndex).toMatchObject({
      available: false,
      name: "compressionEfficiencyIndex",
      reason: "stats_error",
    });
    expect(body.diagnosticRingMax).toBeNull();
    expect(body.diagnosticRingCurrent).toBeNull();
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
