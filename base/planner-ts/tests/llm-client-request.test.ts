import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../src/llm/client.js";

describe("llm client request shaping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SYNESIS_PLANNER_TS_LLM_ENABLED;
    delete process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL;
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
});
