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

  it("keeps broad helper language from outranking concrete architecture domains", () => {
    const profile = buildDomainProfile([
      "I need help designing a production-ready Go job orchestration service for Kubernetes and OpenShift.",
      "Please list the architecture, REST API, state machine, worker model, persistence model, security model, and implementation plan.",
      "The design must be multi-tenant, durable, auditable, horizontally scalable, and restart-safe.",
    ].join(" "));

    const keys = profile.domains.map((domain) => domain.key);
    expect(profile.domains[0]?.key).not.toBe("general");
    expect(keys).toEqual(expect.arrayContaining(["architecture", "cloud_infra"]));
    expect((profile.domains.find((domain) => domain.key === "general")?.weight ?? 0)).toBeLessThan(0.1);
  });
});
