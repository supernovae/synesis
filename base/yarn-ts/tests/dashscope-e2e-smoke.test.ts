import { describe, it, expect, vi } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { customProvider } from "ai";
import { createDashScopeCacheFetch } from "../src/providers/dashscope-cache-interceptor.js";

describe("DashScope interceptor e2e through customProvider", () => {
  it("injects cache_control markers in body sent to DashScope", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        id: "test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop", index: 0 }],
        usage: {
          prompt_tokens: 3000,
          completion_tokens: 1,
          total_tokens: 3001,
          prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 2500 },
        },
      }), { headers: { "content-type": "application/json" } });
    });

    const wrappedFetch = createDashScopeCacheFetch(nativeFetch as unknown as typeof globalThis.fetch, 3);
    const upstream = createOpenAI({
      baseURL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-key",
      fetch: wrappedFetch,
    });
    const provider = customProvider({
      languageModels: { "synesis-core": upstream.chat("qwen3.5-plus") },
    });
    const model = provider.languageModel("synesis-core");

    await model.doGenerate({
      inputFormat: "messages",
      mode: { type: "regular" },
      prompt: [
        { role: "system", content: [{ type: "text", text: "You are helpful. " + "x".repeat(2000) }] },
        { role: "user", content: [{ type: "text", text: "Fix my code" }] },
        { role: "assistant", content: [{ type: "text", text: "Sure" }] },
        { role: "user", content: [{ type: "text", text: "Updated version" }] },
      ],
    });

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(capturedBody).toBeTruthy();

    const messages = capturedBody!.messages as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; cache_control?: { type: string } }>;
    }>;

    // System message should have cache_control marker
    const sysMsg = messages[0];
    expect(Array.isArray(sysMsg.content)).toBe(true);
    const sysBlocks = sysMsg.content as Array<{ cache_control?: { type: string } }>;
    expect(sysBlocks[sysBlocks.length - 1].cache_control).toEqual({ type: "ephemeral" });

    // Count total markers
    let markerCount = 0;
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.cache_control) markerCount++;
        }
      }
    }
    expect(markerCount).toBeGreaterThanOrEqual(1);
    expect(markerCount).toBeLessThanOrEqual(3);

    console.log("Messages after interceptor:");
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const hasCache = Array.isArray(m.content) && (m.content as Array<{ cache_control?: unknown }>).some(b => b.cache_control);
      console.log(`  msg[${i}] role=${m.role} contentIsArray=${Array.isArray(m.content)} hasCache=${hasCache}`);
    }
  });
});
