import { describe, expect, it } from "vitest";
import { validatedNode } from "../src/nodes/validated-node.js";
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
});
