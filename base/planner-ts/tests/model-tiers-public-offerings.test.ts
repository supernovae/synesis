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

  it("accepts only known admin route params before exposing LLM routes", async () => {
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
                  temperature: 0.2,
                  top_p: 0.95,
                  top_k: 40,
                  min_p: 0.05,
                  presence_penalty: 0.1,
                  repetition_penalty: 1.05,
                  enable_thinking: true,
                  reasoning_effort: "medium",
                  model_capability_preset: "qwen3_coder",
                  api_base: "https://llm.internal/v1",
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
      temperature: 0.2,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      presence_penalty: 0.1,
      repetition_penalty: 1.05,
      enable_thinking: true,
      reasoning_effort: "medium",
    });
    expect(route?.baseUrl).toBe("https://llm.internal/v1");
    expect(route?.generationParams?.stop).toBeUndefined();
    expect(route?.generationParams?.logit_bias).toBeUndefined();
    expect(route?.generationParams?.tools).toBeUndefined();
    expect(route?.generationParams?.tool_choice).toBeUndefined();
    expect(route?.generationParams?.parallel_tool_calls).toBeUndefined();
    expect(route?.generationParams?.extra_body).toBeUndefined();
    expect(route?.generationParams?.top_logprobs).toBeUndefined();
    expect(route?.generationParams?.n).toBeUndefined();
  });

  it("rejects broad provider params from role route snapshots", async () => {
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
                role: "writer-horizon",
                assigned: true,
                model: "unsafe-writer",
                endpoint: "https://llm.internal/v1",
                route_params: {
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
                  tool_choice: { type: "function", function: { name: "lookup_trace" } },
                  extra_body: { min_p: 0.2 },
                  role_override: "platform_admin",
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

    expect(catalog.getLlmRoute("writer-horizon")).toBeUndefined();
  });
});
