import { describe, expect, it, vi } from "vitest";
import {
  buildModelArchitectureDiagnostics,
  registerDiagnosticsRoutes,
} from "../src/routes/diagnostics-routes.js";
import type { PlatformRouteDependencies } from "../src/routes/platform-route-support.js";

describe("model architecture diagnostics route", () => {
  it("reports resolved architecture policy for configured model tiers", () => {
    const diagnostics = buildModelArchitectureDiagnostics({
      tierRegistry: {
        getAvailableModels: () => [{ id: "core" }],
        getTierConfig: () => ({
          id: "synesis-core",
          backendModel: "minimax-m2.1",
          baseUrl: "https://openrouter.ai/api/v1",
          adapterHint: "minimax",
          contextCeilingTokens: 128_000,
          architectureProfile: {
            safeToolOutputTokens: 12_000,
            traits: { retrySensitivity: "high" },
          },
        }),
      },
    });

    expect(diagnostics.schema_version).toBe("model_architecture_diagnostics_v1");
    expect(diagnostics.count).toBe(1);
    expect(diagnostics.models[0]).toMatchObject({
      model_id: "core",
      resolved: true,
      tier_id: "synesis-core",
      backend_model: "minimax-m2.1",
      provider: "openrouter",
      adapter_family: "minimax",
      declared_context_tokens: 128_000,
      override_applied: true,
      architecture: {
        decoding: "speculative_friendly",
        safe_tool_output_tokens: 12_000,
        retry_sensitivity: "high",
        strict_stream_tool_boundary_validation: true,
      },
    });
  });

  it("degrades safely when registry entries have no tier config", () => {
    const diagnostics = buildModelArchitectureDiagnostics({
      tierRegistry: {
        getAvailableModels: () => [{ id: "auto" }, { id: "unknown-model" }],
      },
    });

    expect(diagnostics.count).toBe(2);
    expect(diagnostics.models[0]).toMatchObject({
      model_id: "auto",
      resolved: false,
      backend_model: "auto",
      adapter_family: "generic",
      override_applied: false,
      architecture: {
        attention: "unknown",
        prefer_memory_stitching: true,
        prefer_explicit_state_headers: true,
      },
    });
  });

  it("requires the internal diagnostics token over HTTP", async () => {
    const routes = new Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>();
    const app = {
      get: vi.fn((path: string, handler: (req: unknown, reply: ReplyProbe) => Promise<unknown>) => {
        routes.set(path, handler);
      }),
    };
    const deps = {
      app,
      requireInternalToken: vi.fn(() => false),
      diagnosticRegistry: {
        listRecent: vi.fn(),
        getByRequestId: vi.fn(),
        getRingStats: vi.fn(() => ({ max: 10, current: 0 })),
      },
      tierRegistry: {
        getAvailableModels: () => [{ id: "core" }],
      },
    } as unknown as PlatformRouteDependencies;

    registerDiagnosticsRoutes(deps);

    const reply = createReplyProbe();
    await routes.get("/v1/diagnostics/model-architecture")?.({ headers: {} }, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: { type: "auth_error", message: "Unauthorized" } });
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
