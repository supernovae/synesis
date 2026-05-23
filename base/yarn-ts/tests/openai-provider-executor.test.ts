import { describe, expect, it, vi } from "vitest";
import { executePhaseRequiredProviderCall } from "../src/providers/openai-provider-executor.js";
import type { PhaseExecutionPolicyDecision } from "../src/governance/phase-execution-policy.js";

const requiredBashPolicy: PhaseExecutionPolicyDecision = {
  active: true,
  toolChoice: "required",
  allowedCanonicalTools: ["Bash"],
  maxToolCalls: 1,
};

describe("executePhaseRequiredProviderCall", () => {
  it("runs once when required validation passes", async () => {
    const runAttempt = vi.fn(async (messages: string[], toolChoice: "required" | "auto" | undefined) => ({
      result: { toolCalls: [{ toolName: "Bash", input: { command: "npm test" } }] },
      messages,
      toolChoice,
      context: { attempt: "initial" },
    }));
    const finalizeAttempt = vi.fn();

    const out = await executePhaseRequiredProviderCall({
      messages: ["user"],
      toolChoice: "required",
      phasePolicy: requiredBashPolicy,
      governorPhase: "verify",
      runAttempt,
      appendSystemMessage: (messages, content) => [...messages, content],
      getToolCalls: (result) => result.toolCalls,
      finalizeAttempt,
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(finalizeAttempt).toHaveBeenCalledTimes(1);
    expect(out.attempt).toBe("initial");
    expect(out.toolChoice).toBe("required");
  });

  it("retries with repair prompt and falls back to auto when validation still fails", async () => {
    const runAttempt = vi
      .fn()
      .mockImplementationOnce(async (messages: string[], toolChoice: "required" | "auto" | undefined) => ({
        result: { toolCalls: [] },
        messages,
        toolChoice,
      }))
      .mockImplementationOnce(async (messages: string[], toolChoice: "required" | "auto" | undefined) => ({
        result: { toolCalls: [] },
        messages,
        toolChoice,
      }))
      .mockImplementationOnce(async (messages: string[], toolChoice: "required" | "auto" | undefined) => ({
        result: { toolCalls: [{ toolName: "Grep", input: { pattern: "x" } }] },
        messages,
        toolChoice,
      }));
    const retry = vi.fn();
    const fallback = vi.fn();
    const finalizeAttempt = vi.fn();

    const out = await executePhaseRequiredProviderCall({
      messages: ["user"],
      toolChoice: "required",
      phasePolicy: requiredBashPolicy,
      governorPhase: "verify",
      runAttempt,
      appendSystemMessage: (messages, content) => [...messages, content],
      getToolCalls: (result) => result.toolCalls,
      finalizeAttempt,
      onValidationRetry: retry,
      onValidationFallback: fallback,
    });

    expect(runAttempt).toHaveBeenCalledTimes(3);
    expect(retry).toHaveBeenCalledWith(["missing_tool_call"]);
    expect(fallback).toHaveBeenCalledWith(["missing_tool_call"]);
    expect(finalizeAttempt).toHaveBeenCalledTimes(2);
    expect(out.attempt).toBe("fallback");
    expect(out.toolChoice).toBe("auto");
    expect(out.messages.join("\n")).toContain("Phase execution policy fallback");
  });
});
