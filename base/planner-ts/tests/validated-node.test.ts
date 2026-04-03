import { describe, expect, it } from "vitest";
import { validatedNode } from "../src/nodes/validated-node.js";
import { validateMermaidSyntax } from "../src/nodes/contract-validator.js";
import type { GraphState } from "../src/state/types.js";

describe("validatedNode", () => {
  it("injects pre-validation warnings into node input", async () => {
    const validator = () => ({ passed: false, violations: ["pre: warning"] });
    const node = validatedNode(
      async (state: GraphState) => ({ ...state, generated_code: state._validation_warnings?.join(",") ?? "" }),
      [validator],
      []
    );
    const out = await node({});
    expect(out.generated_code).toContain("pre: warning");
  });

  it("annotates critique register on post-validation failure", async () => {
    const validator = () => ({ passed: false, violations: ["style: violation"] });
    const node = validatedNode(async (_state: GraphState) => ({ generated_code: "x" }), [], [validator]);
    const out = await node({});
    const values = Object.values(out.critique_register ?? {});
    expect(values.length).toBe(1);
    expect(values[0]?.status).toBe("open");
  });

  it("routes malformed mermaid through post-validation violations", async () => {
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED = "true";
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_STRICT = "true";
    const node = validatedNode(
      async (_state: GraphState) => ({
        generated_code: [
          "```mermaid",
          "graph TD",
          "A[Start] --> B[End]",
          "click A \"https://example.com\"",
          "```",
        ].join("\n"),
      }),
      [],
      [validateMermaidSyntax],
    );
    const out = await node({});
    const values = Object.values(out.critique_register ?? {});
    expect(values.length).toBeGreaterThan(0);
    expect(values.some((item) => item.description.includes("mermaid_forbidden_directive"))).toBe(true);
  });
});
