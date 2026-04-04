import { describe, expect, it } from "vitest";
import { isLikelyClarificationAnswer } from "../src/clarification/clarification-answer-heuristic.js";

const pending = {
  question: "What region? What scale?",
  options: ["Proceed with assumptions", "AWS us-east-1"],
  assumptions: ["Assume cloud"],
  originalTaskDescription: "Design a system",
};

describe("isLikelyClarificationAnswer", () => {
  it("accepts long answers", () => {
    expect(isLikelyClarificationAnswer("Building an AI pipeline on enterprise knowledge with 90 day plan.", pending)).toBe(true);
  });

  it("accepts proceed-style waivers", () => {
    expect(isLikelyClarificationAnswer("proceed with assumptions", pending)).toBe(true);
    expect(isLikelyClarificationAnswer("go ahead", pending)).toBe(true);
  });

  it("accepts short affirmations", () => {
    expect(isLikelyClarificationAnswer("yes", pending)).toBe(true);
    expect(isLikelyClarificationAnswer("yeah", pending)).toBe(true);
    expect(isLikelyClarificationAnswer("ok", pending)).toBe(true);
    expect(isLikelyClarificationAnswer("sure", pending)).toBe(true);
  });

  it("rejects empty and bare letter answers", () => {
    expect(isLikelyClarificationAnswer("", pending)).toBe(false);
    expect(isLikelyClarificationAnswer("a", pending)).toBe(false);
    expect(isLikelyClarificationAnswer("1", pending)).toBe(false);
  });

  it("matches overlap with question/options when short", () => {
    expect(isLikelyClarificationAnswer("region is us-east", pending)).toBe(true);
  });
});
