import { describe, expect, it } from "vitest";
import { finalScrubberNode } from "../src/pipeline.js";

describe("finalScrubberNode", () => {
  it("removes leaked Plan/Evidence scaffolding and keeps final answer", async () => {
    const state = await finalScrubberNode({
      generated_code: [
        "[planner] still processing...",
        "Plan:",
        "Do internal work.",
        "",
        "Evidence:",
        "internal note",
        "",
        "Answer:",
        "The speed of light in vacuum is 299,792,458 m/s."
      ].join("\n")
    });

    expect(state.generated_code).toBe("The speed of light in vacuum is 299,792,458 m/s.");
  });

  it("handles markdown heading scaffolding variants", async () => {
    const state = await finalScrubberNode({
      generated_code: [
        "## Plan",
        "Do internal work.",
        "",
        "## Evidence",
        "internal note",
        "",
        "## Answer",
        "Final concise answer only."
      ].join("\n")
    });

    expect(state.generated_code).toBe("Final concise answer only.");
  });
});
