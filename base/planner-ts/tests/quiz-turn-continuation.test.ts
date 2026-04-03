import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setFgaCheckOverride } from "../src/auth/openfga-client.js";

beforeAll(() => {
  setFgaCheckOverride(() => ({ allowed: true }));
});

afterAll(() => {
  setFgaCheckOverride(null);
});

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    SYNESIS_PLANNER_TS_LLM_ENABLED: "false",
    ...overrides,
  });
}

function parseSseContent(streamBody: string): string {
  const frames = streamBody.split("\n\n").map((frame) => frame.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const frame of frames) {
    if (!frame.startsWith("data: ")) continue;
    const rawPayload = frame.slice(6).trim();
    if (rawPayload === "[DONE]") continue;
    try {
      const payload = JSON.parse(rawPayload) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string" && delta.content) chunks.push(delta.content);
    } catch {
      // ignore malformed SSE payloads in test parsing helper
    }
  }
  return chunks.join("");
}

describe("quiz turn continuation regression", () => {
  it("merges quiz context for non-stream letter-option follow-up", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis Auto",
        stream: false,
        messages: [
          { role: "user", content: "Help me study vocabulary." },
          {
            role: "assistant",
            content: [
              "Complete the sentence with the correct word:",
              "Despite her _________ nature, she managed to deliver a powerful and passionate speech.",
              "A) timid",
              "B) vibrant",
              "C) hostile",
              "D) cunning",
            ].join("\n"),
          },
          { role: "user", content: "A)" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const content = String(response.json().choices?.[0]?.message?.content ?? "");
    expect(content).toContain("Quiz context:");
    expect(content).toContain("Learner answer:");
    expect(content).toContain("A)");
    expect(content).toContain("Grade the answer against the quiz options");
    await app.close();
  });

  it("merges quiz context for stream follow-up instead of stalling on short answer", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis Auto",
        stream: true,
        messages: [
          { role: "user", content: "Give me a quick vocabulary quiz." },
          {
            role: "assistant",
            content: [
              "Choose the best option:",
              "A) sparse",
              "B) abundant",
              "C) fragile",
              "D) rigid",
            ].join("\n"),
          },
          { role: "user", content: "B)" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const fullContent = parseSseContent(response.body);
    expect(fullContent).toContain("Quiz context:");
    expect(fullContent).toContain("Learner answer:");
    expect(fullContent).toContain("B)");
    expect(fullContent).toContain("Grade the answer against the quiz options");
    await app.close();
  });

  it("recognizes numeric options with compact formatting", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis Auto",
        stream: false,
        messages: [
          { role: "user", content: "Give me a quick multiple choice." },
          { role: "assistant", content: "Pick one: 1)cat 2)dog 3)bird 4)whale" },
          { role: "user", content: "2." },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const content = String(response.json().choices?.[0]?.message?.content ?? "");
    expect(content).toContain("Quiz context:");
    expect(content).toContain("Learner answer:");
    expect(content).toContain("2.");
    await app.close();
  });
});
