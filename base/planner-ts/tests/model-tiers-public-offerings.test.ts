import { afterEach, describe, expect, it, vi } from "vitest";
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
      },
    ]);
    vi.spyOn(catalog, "getRoleBackendModel").mockReturnValue("should-not-be-used");
    const t = resolveTierSettings("xiaomi-2.5");
    expect(t.tier).toBe("core");
    expect(t.registry_writer_role).toBe("writer-core");
    expect(t.resolved_writer_model).toBe("xiaomi-2.5");
  });
});
