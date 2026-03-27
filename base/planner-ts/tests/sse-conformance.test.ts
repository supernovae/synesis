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

function extractReasoningContent(payload: SsePayload): string | undefined {
  const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
  const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
  return typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined;
}

describe("SSE conformance", () => {
  it("emits phase reasoning deltas and final chunk", async () => {
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

    const phaseDeltas = payloads
      .map((p) => extractReasoningContent(p))
      .filter((rc): rc is string => rc !== undefined);
    expect(phaseDeltas.length).toBeGreaterThanOrEqual(2);
    expect(phaseDeltas.some((d) => d.includes("Classifying"))).toBe(true);

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
