import { describe, expect, it } from "vitest";
import { routeAfterCritic } from "../src/nodes/critic-routing.js";

describe("routeAfterCritic", () => {
  it("routes to respond on error", () => {
    expect(routeAfterCritic({ error: "boom" })).toBe("respond");
  });

  it("routes to final_scrubber when approved and no evidence need", () => {
    expect(routeAfterCritic({ critic_approved: true, need_more_evidence: false })).toBe("final_scrubber");
  });

  it("routes to router when more evidence is needed", () => {
    expect(routeAfterCritic({ critic_approved: false, need_more_evidence: true })).toBe("router");
  });

  it("routes to writer when not approved but should continue", () => {
    expect(routeAfterCritic({ critic_approved: false, need_more_evidence: false, critic_should_continue: true })).toBe(
      "writer"
    );
  });

  it("routes to final_scrubber when max iteration reached", () => {
    expect(
      routeAfterCritic({
        iteration_count: 4,
        max_iterations: 4,
        critic_approved: false,
        need_more_evidence: false
      })
    ).toBe("final_scrubber");
  });
});
