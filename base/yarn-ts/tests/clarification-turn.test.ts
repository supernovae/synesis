import { describe, expect, it } from "vitest";
import { looksLikeClarificationTurnAssistantMessage } from "../src/validation/clarification-turn.js";

describe("looksLikeClarificationTurnAssistantMessage", () => {
  it("returns true for numbered clarifying questions block", () => {
    const text = `
Thank you for the detailed requirements. Before I start implementing this ROSA HCP cluster pricing calculator, I'd like to clarify a few points:

1. AWS Authentication: Would you prefer standard credential chain or explicit keys?
2. Pricing Data Source: Should we use AWS Pricing API for EC2?
3. Machine Pool Flexibility: Can users specify different instance types per pool?
4. Commitment Discounts: Should we show both regular and discounted pricing?
5. Output Format: Do you need JSON output for programmatic consumption?

Let me know your preferences and I'll proceed.
`.trim();
    expect(looksLikeClarificationTurnAssistantMessage(text)).toBe(true);
  });

  it("returns false for short completion-style messages", () => {
    expect(looksLikeClarificationTurnAssistantMessage("Done.")).toBe(false);
    expect(looksLikeClarificationTurnAssistantMessage("Implemented the CLI with tests.")).toBe(false);
  });

  it("returns false for implementation summary without question-heavy structure", () => {
    const text = `
I have implemented the golang calculator with AWS Pricing API integration, unit tests in place,
and support for hourly, monthly, and annual output. The tool uses standard AWS credential providers.
All requirements from your spec are addressed.
`.trim();
    expect(looksLikeClarificationTurnAssistantMessage(text)).toBe(false);
  });
});
