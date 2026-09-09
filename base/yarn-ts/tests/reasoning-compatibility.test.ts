import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, jsonSchema, streamText, type LanguageModel } from "ai";
import { SynesisProviderRegistry } from "../src/providers/synesis-provider.js";
import { ChatMessageSchema } from "../src/schemas.js";
import { openAIMessagesToModelMessages } from "../src/tool-mapping.js";
import { buildOpenAINonStreamAssistantMessage } from "../src/pipeline/openai-nonstream-response-message.js";

const history = [
  { role: "user", content: "Remember the project" },
  { role: "assistant", content: "Remembered", reasoning_content: "Earlier reasoning" },
  { role: "user", content: "Read the project" },
  { role: "assistant", content: null, reasoning_content: "Tool reasoning", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
  { role: "tool", tool_call_id: "c1", name: "read", content: "contents" },
];
const tools = { read: { inputSchema: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }) } };
afterEach(() => vi.unstubAllGlobals());

describe("reasoning-compatible model transport", () => {
  it.each(["deepseek-v4-pro", "Qwen3.6-35B-A3B", "kimi-k2.5", "MiniMax-M2.5", "GLM-5"])("round trips assistant reasoning and tool history for %s", async backendModel => {
    let request: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      request = JSON.parse(init.body);
      return Response.json({ id: "r1", created: 1, model: backendModel, choices: [{ index: 0, message: { role: "assistant", content: "Done", reasoning_content: "New reasoning" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
    }));
    const reg = new SynesisProviderRegistry();
    const { model } = reg.resolveAdHoc("core", backendModel, "https://example.com/v1", "test-key");
    const messages = history.map(message => ChatMessageSchema.parse(message));
    const result = await generateText({ model: model as LanguageModel, messages: openAIMessagesToModelMessages(messages as typeof history), tools, providerOptions: { openai: { reasoningEffort: "high", maxCompletionTokens: 256 } }, maxRetries: 0 });
    const sent = request.messages as Array<Record<string, unknown>>;
    expect(sent[1].reasoning_content).toBe("Earlier reasoning");
    expect(sent[3].reasoning_content).toBe("Tool reasoning");
    expect(sent[4].tool_call_id).toBe("c1");
    expect(request.reasoning_effort).toBe("high");
    expect(request.max_tokens).toBe(256);
    expect(request).not.toHaveProperty("maxCompletionTokens");
    const response = buildOpenAINonStreamAssistantMessage({ finalText: result.text, reasoning: result.reasoning, toolCalls: [], effectiveTools: [], clientKind: "generic" });
    expect(response.reasoning_content).toBe("New reasoning");
  });

  it("streams reasoning and preserves it for an opaque DeepSeek preset", async () => {
    let request: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      request = JSON.parse(init.body);
      const chunks = [
        { id: "s1", created: 1, model: "opaque", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Think" }, finish_reason: null }] },
        { id: "s1", created: 1, model: "opaque", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }));
    const reg = new SynesisProviderRegistry();
    reg.updateTiers([{ id: "synesis-core", backendModel: "opaque", baseUrl: "https://api.deepseek.com/v1", apiKey: "test", inputPerM: 0, outputPerM: 0, cachedPerM: 0, cacheWritePerM: null, pricingSource: "manual", modelCapabilityPreset: "deepseek_v4" }]);
    const { model } = reg.resolve("core", "core");
    const result = streamText({ model: model as LanguageModel, messages: openAIMessagesToModelMessages(history), tools, providerOptions: { openai: { enable_thinking: true, reasoningEffort: "max" } }, maxRetries: 0 });
    const events = [];
    for await (const event of result.fullStream) events.push(event);
    expect(events.some(event => event.type === "reasoning-delta" && event.text === "Think")).toBe(true);
    expect(request.thinking).toEqual({ type: "enabled" });
    expect(request.reasoning_effort).toBe("max");
    expect((request.messages as Array<Record<string, unknown>>)[1].reasoning_content).toBe("Earlier reasoning");
  });

  it("does not fabricate missing reasoning or reject nullable reasoning", () => {
    expect(ChatMessageSchema.parse({ role: "assistant", content: "Done", reasoning_content: null }).reasoning_content).toBeNull();
    expect(openAIMessagesToModelMessages([{ role: "assistant", content: "Done" }])).toEqual([{ role: "assistant", content: [{ type: "text", text: "Done" }] }]);
  });
});
