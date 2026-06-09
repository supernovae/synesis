import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveTierSettings } from "../src/model-tiers.js";
import * as catalog from "../src/public-model-catalog.js";

describe("resolveTierSettings with public offerings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches public offering client id to tier and registry role", () => {
    vi.spyOn(catalog, "getPlannerPublicOfferings").mockReturnValue([
      {
        client_model_id: "exp-demo",
        label: "Demo",
        effort_tier: "pulse",
        connection_mode: "role_clone",
        route_via_role: "coder-pulse",
        standalone_provider: null,
        standalone_endpoint: null,
        standalone_api_key_env: null,
        backend_model_override: "route/demo",
      },
    ]);
    vi.spyOn(catalog, "getRoleBackendModel").mockReturnValue(undefined);
    const t = resolveTierSettings("exp-demo");
    expect(t.tier).toBe("pulse");
    expect(t.registry_writer_role).toBe("writer-pulse");
    expect(t.resolved_writer_model).toBe("route/demo");
    expect(t.responseModel).toBe("Demo");
  });

  it("uses client id for standalone planner model when override is unset", () => {
    vi.spyOn(catalog, "getPlannerPublicOfferings").mockReturnValue([
      {
        client_model_id: "xiaomi-2.5",
        label: "Xiaomi 2.5",
        effort_tier: "core",
        connection_mode: "standalone",
        route_via_role: null,
        standalone_provider: "openrouter",
        standalone_endpoint: "https://openrouter.ai/api/v1",
        standalone_api_key_env: "OPENROUTER_API_KEY",
        backend_model_override: null,
        generation_params: { model_capability_preset: "xiaomi_mimo_2_5" },
      },
    ]);
    vi.spyOn(catalog, "getRoleBackendModel").mockReturnValue("should-not-be-used");
    const t = resolveTierSettings("xiaomi-2.5");
    expect(t.tier).toBe("core");
    expect(t.registry_writer_role).toBe("writer-core");
    expect(t.resolved_writer_model).toBe("xiaomi-2.5");
    expect(t.model_capability_preset).toBe("xiaomi_mimo_2_5");
  });

  it("rejects public offerings with unknown generation_params keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            offerings: [
              {
                id: 1,
                client_model_id: "unsafe-public-model",
                label: null,
                effort_tier: "core",
                connection_mode: "standalone",
                route_via_role: null,
                standalone_provider: "openrouter",
                standalone_endpoint: "https://openrouter.ai/api/v1",
                standalone_api_key_env: "OPENROUTER_API_KEY",
                backend_model_override: null,
                generation_params: {
                  model_capability_preset: "xiaomi_mimo_2_5",
                  invented_provider_flag: "unsafe",
                },
                expose_planner: true,
                expose_yarn: false,
                is_active: true,
                created_at: null,
                updated_at: null,
              },
            ],
            for_service: "planner",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ roles: [] }),
        }),
    );

    await catalog.refreshPublicModelCatalog(loadConfig({
      SYNESIS_ADMIN_URL: "http://admin",
      SYNESIS_ADMIN_INTERNAL_TOKEN: "internal-token",
    }));

    expect(catalog.getPlannerPublicOfferings()).toEqual([]);
  });

  it("rejects public offerings with unsafe generation param values", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            offerings: [
              {
                id: 1,
                client_model_id: "unsafe-public-model",
                label: null,
                effort_tier: "core",
                connection_mode: "standalone",
                route_via_role: null,
                standalone_provider: "openrouter",
                standalone_endpoint: "https://openrouter.ai/api/v1",
                standalone_api_key_env: "OPENROUTER_API_KEY",
                backend_model_override: null,
                generation_params: {
                  max_tokens: 2_000_001,
                  temperature: 3,
                  reasoning_effort: "platform_admin",
                },
                expose_planner: true,
                expose_yarn: false,
                is_active: true,
                created_at: null,
                updated_at: null,
              },
            ],
            for_service: "planner",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ roles: [] }),
        }),
    );

    await catalog.refreshPublicModelCatalog(loadConfig({
      SYNESIS_ADMIN_URL: "http://admin",
      SYNESIS_ADMIN_INTERNAL_TOKEN: "internal-token",
    }));

    expect(catalog.getPlannerPublicOfferings()).toEqual([]);
  });

  it("sanitizes role route generation params before exposing LLM routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            offerings: [],
            for_service: "planner",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            roles: [
              {
                role: "writer-core",
                assigned: true,
                model: "safe-writer",
                endpoint: "https://llm.internal/v1",
                route_params: {
                  max_tokens: 2048,
                  temperature: 3,
                  top_p: 1.2,
                  reasoning_effort: "platform_admin",
                  stop: Array.from({ length: 17 }, (_, i) => `stop-${i}`),
                  top_logprobs: 21,
                  n: 0,
                  logit_bias: {
                    "123": -1,
                    "456": 101,
                    role_override: 100,
                  },
                  tools: [
                    {
                      type: "function",
                      function: {
                        name: "lookup_trace",
                        parameters: { type: "object", properties: { query: { type: "string" } } },
                      },
                    },
                  ],
                  tool_choice: {
                    type: "function",
                    function: { name: "lookup_trace" },
                    role_override: "platform_admin",
                  },
                  extra_body: {
                    min_p: 0.2,
                    custom_provider_option: "unsafe",
                  },
                },
              },
            ],
          }),
        }),
    );

    await catalog.refreshPublicModelCatalog(loadConfig({
      SYNESIS_ADMIN_URL: "http://admin",
      SYNESIS_ADMIN_INTERNAL_TOKEN: "internal-token",
    }));

    const route = catalog.getLlmRoute("writer-core");
    expect(route?.generationParams).toMatchObject({
      max_tokens: 2048,
      logit_bias: { "123": -1 },
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_trace",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
      extra_body: { min_p: 0.2 },
    });
    expect(route?.generationParams?.logit_bias).toEqual({ "123": -1 });
    expect(route?.generationParams?.tool_choice).toBeUndefined();
    expect(route?.generationParams?.temperature).toBeUndefined();
    expect(route?.generationParams?.top_p).toBeUndefined();
    expect(route?.generationParams?.reasoning_effort).toBeUndefined();
    expect(route?.generationParams?.stop).toBeUndefined();
    expect(route?.generationParams?.top_logprobs).toBeUndefined();
    expect(route?.generationParams?.n).toBeUndefined();
    expect(JSON.stringify(route?.generationParams)).not.toContain("role_override");
    expect(JSON.stringify(route?.generationParams)).not.toContain("custom_provider_option");
  });
});
