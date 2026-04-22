import { describe, it, expect } from "vitest";
import { buildPromptMessages, computeVolatileFingerprint, type PromptFrame } from "../src/context/prompt-frame.js";

function makeFrame(overrides: Partial<PromptFrame> = {}): PromptFrame {
  return {
    stablePrefix: "You are an AI assistant.",
    projectContext: null,
    volatileAdapter: null,
    workingFrame: null,
    structuralCritic: null,
    projectManifest: null,
    structuralIndex: null,
    fileSummary: null,
    verificationPlan: null,
    extendedMemoryBlocks: [],
    responseStyle: null,
    governanceBlocks: [],
    intentGate: null,
    toolEfficiency: "<TOOL_EFFICIENCY>Be efficient.</TOOL_EFFICIENCY>",
    ...overrides,
  };
}

describe("buildPromptMessages", () => {
  it("builds minimal prompt with just stable prefix + tool efficiency", () => {
    const frame = makeFrame();
    const conv = [{ role: "user", content: "hello" }];
    const result = buildPromptMessages(frame, conv);

    expect(result).toHaveLength(3); // system prefix, system volatile, user
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("You are an AI assistant.");
    expect(result[1].role).toBe("system");
    expect(result[1].content).toContain("TOOL_EFFICIENCY");
    expect(result[2].role).toBe("user");
    expect(result[2].content).toBe("hello");
  });

  it("includes project context in the prefix message", () => {
    const frame = makeFrame({ projectContext: '<PROJECT_ROOT path="/app" dirs="src,tests" />' });
    const result = buildPromptMessages(frame, []);

    expect(result[0].content).toContain("You are an AI assistant.");
    expect(result[0].content).toContain("PROJECT_ROOT");
  });

  it("joins volatile blocks with separator", () => {
    const frame = makeFrame({
      volatileAdapter: "adapter content",
      workingFrame: "<WORKING_FRAME>frame</WORKING_FRAME>",
      responseStyle: "<RESPONSE_STYLE>style</RESPONSE_STYLE>",
    });
    const result = buildPromptMessages(frame, []);
    const volatile = result[1].content as string;
    expect(volatile).toContain("adapter content");
    expect(volatile).toContain("WORKING_FRAME");
    expect(volatile).toContain("RESPONSE_STYLE");
    expect(volatile).toContain("---");
  });

  it("includes governance blocks in volatile content", () => {
    const frame = makeFrame({
      governanceBlocks: ["<TASK_INTAKE>task</TASK_INTAKE>", "<PLAN_PROGRESS>graph</PLAN_PROGRESS>"],
    });
    const result = buildPromptMessages(frame, []);
    const volatile = result[1].content as string;
    expect(volatile).toContain("TASK_INTAKE");
    expect(volatile).toContain("PLAN_PROGRESS");
  });

  it("skips empty governance blocks", () => {
    const frame = makeFrame({
      governanceBlocks: ["", "  ", "<REAL_BLOCK>content</REAL_BLOCK>"],
    });
    const result = buildPromptMessages(frame, []);
    const volatile = result[1].content as string;
    expect(volatile).toContain("REAL_BLOCK");
    expect(volatile).not.toContain("\n---\n\n---\n");
  });

  it("preserves conversation message order", () => {
    const frame = makeFrame();
    const conv = [
      { role: "user", content: "step 1" },
      { role: "assistant", content: "ok 1" },
      { role: "user", content: "step 2" },
    ];
    const result = buildPromptMessages(frame, conv);
    const convPart = result.slice(2);
    expect(convPart).toHaveLength(3);
    expect(convPart[0].content).toBe("step 1");
    expect(convPart[1].content).toBe("ok 1");
    expect(convPart[2].content).toBe("step 2");
  });
});

describe("computeVolatileFingerprint", () => {
  it("returns stable fingerprint for identical frames", () => {
    const frame = makeFrame({ workingFrame: "frame content", responseStyle: "style" });
    const fp1 = computeVolatileFingerprint(frame);
    const fp2 = computeVolatileFingerprint(frame);
    expect(fp1).toBe(fp2);
  });

  it("changes when a volatile block changes", () => {
    const frame1 = makeFrame({ workingFrame: "version 1" });
    const frame2 = makeFrame({ workingFrame: "version 2" });
    expect(computeVolatileFingerprint(frame1)).not.toBe(computeVolatileFingerprint(frame2));
  });

  it("changes when governance blocks change", () => {
    const frame1 = makeFrame({ governanceBlocks: ["block A"] });
    const frame2 = makeFrame({ governanceBlocks: ["block B"] });
    expect(computeVolatileFingerprint(frame1)).not.toBe(computeVolatileFingerprint(frame2));
  });

  it("always includes toolEfficiency", () => {
    const frame = makeFrame();
    const fp = computeVolatileFingerprint(frame);
    expect(fp).toContain("TOOL_EFFICIENCY");
  });
});
