import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setFgaCheckOverride } from "../src/auth/openfga-client.js";

beforeAll(() => { setFgaCheckOverride(() => ({ allowed: true })); });
afterAll(() => { setFgaCheckOverride(null); });
afterEach(() => { vi.restoreAllMocks(); });

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    ...overrides
  });
}

type SsePayload = Record<string, unknown>;

function parseSsePayloads(streamBody: string): SsePayload[] {
  const frames = streamBody
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean);

  const payloads: SsePayload[] = [];
  for (const frame of frames) {
    if (!frame.startsWith("data: ")) continue;
    const raw = frame.slice(6).trim();
    if (raw === "[DONE]") continue;
    payloads.push(JSON.parse(raw) as SsePayload);
  }
  return payloads;
}

describe("SSE conformance", () => {
  it("emits strict OpenAI-compatible chunks and final usage by default", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "Provide planner summary" }],
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(typeof response.headers["x-synesis-run-id"]).toBe("string");
    expect(response.body).toContain("[DONE]");

    const payloads = parseSsePayloads(response.body);
    expect(payloads.length).toBeGreaterThan(2);
    for (const payload of payloads) {
      expect(payload.object).toBe("chat.completion.chunk");
      expect(payload).not.toHaveProperty("event");
      expect(payload).not.toHaveProperty("run_id");
      expect(payload).not.toHaveProperty("authz_trace_id");
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
      expect(delta).not.toHaveProperty("reasoning_content");
    }

    const roleBootstrap = payloads.find((p) => {
      const choices = Array.isArray(p.choices) ? p.choices as Array<Record<string, unknown>> : [];
      const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
      return delta.role === "assistant";
    });
    expect(roleBootstrap).toBeTruthy();

    const chunks = payloads.filter((payload) => payload.object === "chat.completion.chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const finalChunk =
      [...chunks].reverse().find((p) => typeof p.usage === "object") ?? chunks[chunks.length - 1] ?? {};
    const choices = Array.isArray(finalChunk.choices) ? (finalChunk.choices as Array<Record<string, unknown>>) : [];
    const firstChoice = choices[0] ?? {};
    expect(firstChoice.finish_reason).toBe("stop");
    expect(firstChoice.logprobs).toBeNull();
    expect(typeof finalChunk.usage).toBe("object");
    expect(typeof finalChunk.system_fingerprint).toBe("string");

    await app.close();
  });

  it("can emit legacy Open WebUI status frames when explicitly enabled", async () => {
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS: "openwebui-data" }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "Provide planner summary" }],
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    const payloads = parseSsePayloads(response.body);
    expect(payloads.some((payload) => payload.event)).toBe(true);
    expect(payloads.some((payload) => {
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
      return typeof delta.reasoning_content === "string";
    })).toBe(true);

    await app.close();
  });

  it("posts side-channel Open WebUI statuses without adding status frames to strict SSE", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("true", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const app = buildApp(makeConfig({
      SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL: "http://open-webui.synesis-webui.svc.cluster.local:8080",
      SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN: "event-token",
    }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "Provide planner summary" }],
        metadata: { chat_id: "chat-1", message_id: "message-1" },
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const payloads = parseSsePayloads(response.body);
    expect(payloads.every((payload) => payload.object === "chat.completion.chunk")).toBe(true);
    expect(response.body).not.toContain('"event"');
    expect(response.body).not.toContain("Preparing request...");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://open-webui.synesis-webui.svc.cluster.local:8080/api/v1/chats/chat-1/messages/message-1/event",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"type":"status"'),
      }),
    );

    await app.close();
  });
});
