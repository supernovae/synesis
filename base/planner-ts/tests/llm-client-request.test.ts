import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../src/llm/client.js";

describe("llm client request shaping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SYNESIS_PLANNER_TS_LLM_ENABLED;
    delete process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL;
    delete process.env.XAI_API_KEY;
    delete process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE;
  });

  it("passes response_format through to provider request body", async () => {
    process.env.SYNESIS_PLANNER_TS_LLM_ENABLED = "true";
    process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL = "http://example.invalid/v1";
    process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE = "disabled";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "synesis-writer",
            choices: [{ index: 0, message: { role: "assistant", content: "{\"steps\":[{\"id\":1,\"action\":\"x\"}]}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    await chatCompletion({
      model: "synesis-writer",
      messages: [{ role: "user", content: "plan this" }],
      response_format: { type: "json_object" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("passes common OpenAI chat parameters through to provider request body", async () => {
    process.env.SYNESIS_PLANNER_TS_LLM_ENABLED = "true";
    process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL = "http://example.invalid/v1";
    process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE = "disabled";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "synesis-writer",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    await chatCompletion({
      model: "synesis-writer",
      messages: [{ role: "user", content: "plan this" }],
      temperature: 0.3,
      top_p: 0.7,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      stop: ["END"],
      seed: 42,
      logit_bias: { "123": -1 },
      logprobs: true,
      top_logprobs: 3,
      n: 1,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      extra_body: { min_p: 0.1, custom_provider_option: "x" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.7);
    expect(body.presence_penalty).toBe(0.1);
    expect(body.frequency_penalty).toBe(0.2);
    expect(body.stop).toEqual(["END"]);
    expect(body.seed).toBe(42);
    expect(body.logit_bias).toEqual({ "123": -1 });
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(3);
    expect(body.n).toBe(1);
    expect(body.tools).toEqual([{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.extra_body.min_p).toBe(0.1);
    expect(body.extra_body.custom_provider_option).toBeUndefined();
  });

  it("uses a direct admin route for base URL, API key env, model, and generation defaults", async () => {
    process.env.SYNESIS_PLANNER_TS_LLM_ENABLED = "true";
    process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE = "disabled";
    process.env.XAI_API_KEY = "xai-secret";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "grok-4-fast",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    await chatCompletion({
      model: "synesis-planner",
      route: {
        model: "grok-4-fast",
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
        provider: "xai",
        role: "planner",
        generationParams: {
          reasoning_effort: "low",
          temperature: 3,
          top_p: 1.5,
          top_k: 20,
          frequency_penalty: 0.2,
          stop: Array.from({ length: 17 }, (_, i) => `stop-${i}`),
          logit_bias: { "123": -1, "456": 101, role_override: 100 },
          top_logprobs: 21,
          tools: [
            {
              type: "function",
              function: {
                name: "lookup_trace",
                parameters: { type: "object", properties: { query: { type: "string" } } },
                role_override: "platform_admin",
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "lookup_trace" }, role_override: "platform_admin" },
          parallel_tool_calls: false,
          extra_body: { min_p: 0.2, custom_provider_option: "x" },
        },
      },
      messages: [{ role: "user", content: "plan this" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/chat/completions");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe("Bearer xai-secret");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("grok-4-fast");
    expect(body.reasoning_effort).toBe("low");
    expect(body.temperature).toBe(0);
    expect(body.top_p).toBeUndefined();
    expect(body.frequency_penalty).toBe(0.2);
    expect(body.stop).toBeUndefined();
    expect(body.logit_bias).toEqual({ "123": -1 });
    expect(body.top_logprobs).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.extra_body.top_k).toBe(20);
    expect(body.extra_body.min_p).toBe(0.2);
    expect(body.extra_body.custom_provider_option).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("role_override");
  });
});
