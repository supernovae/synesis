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
            choices: [{ message: { content: "{\"steps\":[{\"id\":1,\"action\":\"x\"}]}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    await chatCompletion({
      model: "synesis-general",
      messages: [{ role: "user", content: "plan this" }],
      response_format: { type: "json_object" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: "json_object" });
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
            choices: [{ message: { content: "ok" } }],
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
        generationParams: { reasoning_effort: "low", top_k: 20 },
      },
      messages: [{ role: "user", content: "plan this" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/chat/completions");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xai-secret");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("grok-4-fast");
    expect(body.reasoning_effort).toBe("low");
    expect(body.extra_body.top_k).toBe(20);
  });
});
