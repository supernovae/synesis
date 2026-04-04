import { describe, expect, it } from "vitest";
import {
  mergeSynesisClarificationFromRequestMetadata,
  parseSynesisClarificationRound,
} from "../src/validation/clarification-schema.js";

describe("clarification schema", () => {
  it("parses valid round object", () => {
    const r = parseSynesisClarificationRound({
      round_id: "r1",
      questions: [{ id: "q1", prompt: "Auth method?", required: true }],
    });
    expect(r?.round_id).toBe("r1");
    expect(r?.questions[0]?.id).toBe("q1");
  });

  it("parses JSON string payload", () => {
    const r = parseSynesisClarificationRound(
      JSON.stringify({
        round_id: "r2",
        questions: [{ id: "a", prompt: "Region?" }],
      }),
    );
    expect(r?.round_id).toBe("r2");
  });

  it("rejects invalid payloads", () => {
    expect(parseSynesisClarificationRound(null)).toBeNull();
    expect(parseSynesisClarificationRound({})).toBeNull();
    expect(parseSynesisClarificationRound("not json")).toBeNull();
  });

  it("merges into session metadata", () => {
    const meta: Record<string, unknown> = {};
    mergeSynesisClarificationFromRequestMetadata(meta, {
      synesis_clarification_round: { round_id: "x", questions: [{ id: "1", prompt: "?" }] },
    });
    expect((meta.synesis_clarification_round as { round_id: string }).round_id).toBe("x");
  });
});
