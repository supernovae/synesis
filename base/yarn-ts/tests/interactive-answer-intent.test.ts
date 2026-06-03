import { describe, expect, it } from "vitest";
import {
  classifyInteractiveAnswerText,
  hasRecentPlanReadyPrompt,
  isPlanImplementationApprovalMessages,
  isQuestionToolName,
} from "../src/adapters/interactive-answer-intent.js";

describe("interactive answer intent", () => {
  it("recognizes plan approval answers only when plan-ready context exists", () => {
    expect(classifyInteractiveAnswerText("Proceed with implementation", { planReadyContext: true }))
      .toBe("approve_plan");
    expect(classifyInteractiveAnswerText("Proceed with implementation", { planReadyContext: false }))
      .toBe("request_implementation");
  });

  it("recognizes harness-specific proceed choices from question tools", () => {
    const messages = [
      { role: "user", content: "/plan build a Rust app" },
      { role: "assistant", content: "Claude has written up a plan and is ready to execute. Would you like to proceed?" },
      { role: "tool_result", name: "question", content: "Yes, auto-accept edits" },
    ];

    expect(hasRecentPlanReadyPrompt(messages)).toBe(true);
    expect(isPlanImplementationApprovalMessages(messages)).toBe(true);
  });

  it("recognizes Pi or generic plain-text approval after a plan preview", () => {
    expect(isPlanImplementationApprovalMessages([
      { role: "user", content: "/plan build a Rust app" },
      { role: "assistant", content: "Ready to code?\n\nHere is the plan." },
      { role: "user", content: "implement the plan" },
    ])).toBe(true);
  });

  it("does not treat change-plan answers as approval", () => {
    expect(classifyInteractiveAnswerText("Tell Claude what to change", { planReadyContext: true }))
      .toBe("request_plan_changes");
    expect(isPlanImplementationApprovalMessages([
      { role: "user", content: "/plan build a Rust app" },
      { role: "assistant", content: "Ready to code?\n\nHere is the plan." },
      { role: "tool_result", name: "AskUserQuestion", content: "Tell Claude what to change" },
    ])).toBe(false);
  });

  it("normalizes common question tool names across harnesses", () => {
    expect(isQuestionToolName("AskUserQuestion")).toBe(true);
    expect(isQuestionToolName("ask_followup_question")).toBe(true);
    expect(isQuestionToolName("question")).toBe(true);
    expect(isQuestionToolName("TodoWrite")).toBe(false);
  });
});
