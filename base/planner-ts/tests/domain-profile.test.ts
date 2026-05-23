import { describe, expect, it } from "vitest";
import { buildDomainProfile } from "../src/nodes/domain-profile.js";

describe("domain profile", () => {
  it("recognizes Go HTTP service operations as development/backend, not general", () => {
    const profile = buildDomainProfile(
      "For a Go HTTP service, how should I configure server timeouts, request context cancellation, and graceful shutdown?",
    );

    const keys = profile.domains.map((domain) => domain.key);
    expect(keys).toContain("golang");
    expect(keys).toContain("backend_api");
    expect(keys).not.toEqual(["general"]);
    expect(profile.frameCoherence).toMatch(/focused|composite/);
  });
});
