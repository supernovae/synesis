import { describe, it, expect, vi } from "vitest";
import {
  selectBreakpoints,
  injectCacheMarkers,
  createDashScopeCacheFetch,
} from "../src/providers/dashscope-cache-interceptor.js";

describe("selectBreakpoints", () => {
  it("returns empty for empty messages", () => {
    expect(selectBreakpoints([], 3)).toEqual([]);
  });

  it("returns empty when maxMarkers is 0", () => {
    const msgs = [{ role: "system", content: "hello" }];
    expect(selectBreakpoints(msgs, 0)).toEqual([]);
  });

  it("places marker on last system message", () => {
    const msgs = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      { role: "user", content: "hi" },
    ];
    const bp = selectBreakpoints(msgs, 1);
    expect(bp).toEqual([1]);
  });

  it("places up to 4 markers at strategic positions", () => {
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third question" },
    ];
    const bp = selectBreakpoints(msgs, 4);
    expect(bp).toEqual([0, 1, 4, 5]);
  });

  it("respects maxMarkers limit", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    const bp = selectBreakpoints(msgs, 2);
    expect(bp.length).toBeLessThanOrEqual(2);
  });
});

describe("injectCacheMarkers", () => {
  it("converts string content to array with cache_control", () => {
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];
    const result = injectCacheMarkers(msgs, [0, 1]);
    const sys = result[0];
    expect(Array.isArray(sys.content)).toBe(true);
    const blocks = sys.content as Array<{ type: string; text?: string; cache_control?: { type: string } }>;
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].text).toBe("system prompt");
  });

  it("preserves array content and tags last block", () => {
    const msgs = [
      {
        role: "system",
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
      { role: "user", content: "hi" },
    ];
    const result = injectCacheMarkers(msgs, [0, 1]);
    const blocks = result[0].content as Array<{ type: string; text?: string; cache_control?: { type: string } }>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not mutate unmarked messages", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    const result = injectCacheMarkers(msgs, [0]);
    expect(result[1].content).toBe("q1");
    expect(result[2].content).toBe("a1");
    expect(result[3].content).toBe("q2");
  });
});

describe("createDashScopeCacheFetch", () => {
  it("injects markers into JSON body with messages", async () => {
    const captured: { body?: string } = {};
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response(JSON.stringify({ choices: [] }));
    });

    const wrapped = createDashScopeCacheFetch(mockFetch as unknown as typeof globalThis.fetch, 2);
    const body = JSON.stringify({
      model: "qwen3.6-plus",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
    });

    await wrapped("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      body,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(captured.body!);
    const sysMsg = parsed.messages[0];
    expect(Array.isArray(sysMsg.content)).toBe(true);
    expect(sysMsg.content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("passes through non-string body unmodified", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    const wrapped = createDashScopeCacheFetch(mockFetch as unknown as typeof globalThis.fetch);

    await wrapped("https://dashscope.aliyuncs.com/v1/chat", { method: "POST" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes through body without messages array", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    const wrapped = createDashScopeCacheFetch(mockFetch as unknown as typeof globalThis.fetch);

    await wrapped("https://dashscope.aliyuncs.com/v1/completions", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
    });
    const parsed = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(parsed.messages).toBeUndefined();
    expect(parsed.prompt).toBe("hello");
  });

  it("survives malformed JSON gracefully", async () => {
    const mockFetch = vi.fn(async () => new Response("ok"));
    const wrapped = createDashScopeCacheFetch(mockFetch as unknown as typeof globalThis.fetch);

    await wrapped("https://dashscope.aliyuncs.com/v1/chat", {
      method: "POST",
      body: "not json{",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0][1] as RequestInit).body).toBe("not json{");
  });
});
