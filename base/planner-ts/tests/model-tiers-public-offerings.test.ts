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
        backend_model_override: "litellm/demo",
      },
    ]);
    vi.spyOn(catalog, "getRoleBackendModel").mockReturnValue(undefined);
    const t = resolveTierSettings("exp-demo");
    expect(t.tier).toBe("pulse");
    expect(t.registry_general_role).toBe("general-pulse");
    expect(t.resolved_writer_model).toBe("litellm/demo");
    expect(t.responseModel).toBe("Demo");
  });
});
