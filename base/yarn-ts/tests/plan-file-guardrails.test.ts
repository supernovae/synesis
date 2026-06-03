import { describe, expect, it } from "vitest";

import { injectPlanModeRecoveryHint } from "../src/planning/plan-file-guardrails.js";

describe("plan file guardrails", () => {
  it("turns already-approved ExitPlanMode errors into implementation guidance", () => {
    const messages = [
      { role: "user", content: "/plan build a Rust workspace" },
      { role: "assistant", content: "The plan is ready. Ready to code?" },
      {
        role: "tool",
        content: "Error: You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
      },
    ];

    expect(injectPlanModeRecoveryHint(messages)).toBe(true);
    const injected = String(messages.at(-1)?.content ?? "");
    expect(injected).toContain("plan_mode_exit_already_approved");
    expect(injected).toContain("Continue with implementation now");
    expect(injected).toContain("Do NOT update or rewrite the plan file again");
    expect(injected).not.toContain("cat > path");
  });

  it("keeps plan-file update guidance for generic plan mode update errors", () => {
    const messages = [
      { role: "user", content: "/plan build a Rust workspace" },
      {
        role: "tool",
        content: "Error: You are not in plan mode.",
      },
    ];

    expect(injectPlanModeRecoveryHint(messages)).toBe(true);
    const injected = String(messages.at(-1)?.content ?? "");
    expect(injected).toContain("source=\"plan_mode_error\"");
    expect(injected).toContain("Only if the plan file itself still needs updating");
    expect(injected).toContain("continue with the implementation task");
  });
});
