import { describe, expect, it } from "vitest";
import {
  buildPromptIntakeSystemBlock,
  evaluatePromptIntake,
} from "../src/index.js";

describe("prompt intake", () => {
  it.each([
    "fix the missing import in src/auth.ts",
    "fix the auth bug in login.ts",
    "tweak the button padding",
    "optimize this loop",
    "refactor this helper function",
  ])("allows concrete micro task: %s", (prompt) => {
    const decision = evaluatePromptIntake({ prompt });

    expect(decision.scope).toBe("micro");
    expect(decision.action).toBe("allow");
    expect(decision.planning_steered).toBe(false);
    expect(buildPromptIntakeSystemBlock(decision)).toBeNull();
  });

  it.each([
    "build a new FastAPI service with auth, database migrations, and a frontend",
    "implement a new payment workflow from scratch",
    "architect and design a multi-tenant ingestion system",
    "create a complete app that imports data, stores it, exposes an API, and renders an admin UI",
  ])("steers macro task toward planning: %s", (prompt) => {
    const decision = evaluatePromptIntake({ prompt });

    expect(decision.scope).toBe("macro");
    expect(decision.action).toBe("steer");
    expect(decision.planning_steered).toBe(true);
    expect(buildPromptIntakeSystemBlock(decision)).toContain("planning_suggested");
  });

  it("respects natural language refusal while still classifying macro scope", () => {
    const decision = evaluatePromptIntake({
      prompt: "just code it: build a new app with auth, billing, and an admin UI",
    });

    expect(decision.scope).toBe("macro");
    expect(decision.action).toBe("allow");
    expect(decision.override).toBe(true);
    expect(decision.reasons).toContain("prompt.natural_language_override");
  });

  it("honors explicit planning override while still classifying the prompt", () => {
    const decision = evaluatePromptIntake({
      prompt: "build a new app with auth, billing, and an admin UI",
      planningOverride: true,
      customStyle: "No plan. Output compact code.",
    });

    expect(decision.scope).toBe("macro");
    expect(decision.action).toBe("allow");
    expect(decision.override).toBe(true);
    expect(decision.custom_style).toBe("No plan. Output compact code.");
    expect(buildPromptIntakeSystemBlock(decision)).toBeNull();
  });

  it("classifies long listed requests as macro even without a broad verb", () => {
    const prompt = [
      "Need improvements:",
      "- API endpoint compatibility",
      "- auth behavior",
      "- migration coverage",
      "- frontend status panel",
      "- tests and rollout notes",
      "Please handle all of this carefully and include the edge cases.",
    ].join("\n");

    const decision = evaluatePromptIntake({ prompt });

    expect(decision.scope).toBe("macro");
    expect(decision.action).toBe("steer");
    expect(decision.reasons).toContain("macro.listed_requirements");
  });
});
