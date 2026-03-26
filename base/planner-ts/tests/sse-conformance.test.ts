import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

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
  it("emits status phases with stable authz trace and final chunk", async () => {
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
    expect(response.body).toContain("[DONE]");

    const payloads = parseSsePayloads(response.body);
    expect(payloads.length).toBeGreaterThan(2);

    const statusEvents = payloads
      .filter((payload) => typeof payload.event === "object" && payload.event !== null)
      .map((payload) => payload.event as Record<string, unknown>);
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);

    const initial = statusEvents[0] ?? {};
    expect(String(initial.description ?? "")).toBe("Planner request accepted");
    expect(initial.done).toBe(false);

    const authzTraceId = String(initial.authz_trace_id ?? "");
    expect(authzTraceId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(statusEvents.every((event) => String(event.authz_trace_id ?? "") === authzTraceId)).toBe(true);

    const finalStatus = statusEvents[statusEvents.length - 1] ?? {};
    expect(finalStatus.done).toBe(true);
    expect(String(finalStatus.node ?? "")).toBe("respond");

    const chunks = payloads.filter((payload) => payload.object === "chat.completion.chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const finalChunk = chunks[chunks.length - 1] ?? {};
    const choices = Array.isArray(finalChunk.choices) ? (finalChunk.choices as Array<Record<string, unknown>>) : [];
    const firstChoice = choices[0] ?? {};
    expect(firstChoice.finish_reason).toBe("stop");
    expect(typeof finalChunk.usage).toBe("object");

    await app.close();
  });
});
