import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { setFgaCheckOverride } from "../src/auth/openfga-client.js";
import { loadConfig } from "../src/config.js";

beforeAll(() => {
  setFgaCheckOverride(() => ({ allowed: true }));
});

afterAll(() => {
  setFgaCheckOverride(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SYNESIS_PLANNER_TS_LLM_ENABLED;
  delete process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL;
  delete process.env.SYNESIS_PLANNER_TS_LLM_API_KEY;
  delete process.env.SYNESIS_PLANNER_TS_WRITER_MODEL;
  delete process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE;
});

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    ...overrides,
  });
}

function enableNativeLlm() {
  process.env.SYNESIS_PLANNER_TS_LLM_ENABLED = "true";
  process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL = "http://provider.test/v1";
  process.env.SYNESIS_PLANNER_TS_LLM_API_KEY = "test-key";
  process.env.SYNESIS_PLANNER_TS_WRITER_MODEL = "native-writer";
  process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE = "disabled";
}

describe("native OpenAI tool passthrough", () => {
  it("returns upstream tool_calls for OpenAI-compatible tool requests", async () => {
    enableNativeLlm();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-tool",
          object: "chat.completion",
          created: 1,
          model: "native-writer",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup_trace", arguments: "{\"trace_id\":\"abc\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const app = buildApp(makeConfig());

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "Summarize trace abc" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_trace",
              parameters: { type: "object", properties: { trace_id: { type: "string" } } },
            },
          },
        ],
        tool_choice: "auto",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("lookup_trace");
    expect(body.choices?.[0]?.finish_reason).toBe("tool_calls");
    const upstreamBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://provider.test/v1/chat/completions");
    expect(upstreamBody.model).toBe("native-writer");
    expect(upstreamBody.tools?.[0]?.function?.name).toBe("lookup_trace");
    expect(upstreamBody.tool_choice).toBe("auto");

    await app.close();
  });

  it("passes assistant tool_calls and tool result messages back upstream", async () => {
    enableNativeLlm();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-final",
          object: "chat.completion",
          created: 1,
          model: "native-writer",
          choices: [{ index: 0, message: { role: "assistant", content: "Trace summary" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const app = buildApp(makeConfig());

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [
          { role: "user", content: "Summarize trace abc" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup_trace", arguments: "{\"trace_id\":\"abc\"}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "{\"trace_id\":\"abc\",\"duration_ms\":42}" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices?.[0]?.message?.content).toBe("Trace summary");
    const upstreamBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(upstreamBody.messages[1].tool_calls[0].id).toBe("call_1");
    expect(upstreamBody.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "{\"trace_id\":\"abc\",\"duration_ms\":42}",
    });

    await app.close();
  });

  it("streams upstream tool_call deltas unchanged", async () => {
    enableNativeLlm();
    const sse = [
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"native-writer","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"native-writer","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup_trace","arguments":"{}"}}]},"finish_reason":null}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const app = buildApp(makeConfig());

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        stream: true,
        messages: [{ role: "user", content: "Summarize trace abc" }],
        tools: [{ type: "function", function: { name: "lookup_trace", parameters: { type: "object" } } }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("\"tool_calls\"");
    expect(response.body).toContain("[DONE]");

    await app.close();
  });
});
