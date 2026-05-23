import { describe, expect, it, vi } from "vitest";
import { OpenAIChatPipeline } from "../src/pipeline/openai-chat-pipeline.js";
import type { PipelineContext } from "../src/pipeline/types.js";

function ctx(mode: PipelineContext["mode"]): PipelineContext {
  return {
    requestId: "r1",
    mode,
    userId: "u1",
    orgId: "o1",
    clientKind: "test",
    conversationId: "c1",
    startedAt: 1,
  };
}

describe("OpenAIChatPipeline seams", () => {
  it("does not call governor hooks in raw or compat modes", async () => {
    const governor = { beforeProviderCall: vi.fn() };
    const pipeline = new OpenAIChatPipeline({ governorService: governor as never });

    await pipeline.beforeProviderCall(ctx("raw"), { messages: [] });
    await pipeline.beforeProviderCall(ctx("compat"), { messages: [] });

    expect(governor.beforeProviderCall).not.toHaveBeenCalled();
  });

  it("calls governor hooks in governed mode", async () => {
    const governor = { beforeProviderCall: vi.fn().mockResolvedValue({ action: "pass" }) };
    const pipeline = new OpenAIChatPipeline({ governorService: governor as never });

    const out = await pipeline.beforeProviderCall(ctx("governed"), { messages: [{ role: "user", content: "hi" }] });

    expect(governor.beforeProviderCall).toHaveBeenCalledOnce();
    expect(out).toEqual({ action: "pass" });
  });
});
