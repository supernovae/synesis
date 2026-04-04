/**
 * Regression: clarification content must be streamed as an SSE content delta
 * even though the writer node is bypassed (planner → plan_gate → respond).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setFgaCheckOverride } from "../src/auth/openfga-client.js";

beforeAll(() => { setFgaCheckOverride(() => ({ allowed: true })); });
afterAll(() => { setFgaCheckOverride(null); });

const chatCompletionMock = vi.fn();

vi.mock("../src/llm/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/client.js")>("../src/llm/client.js");
  return {
    ...actual,
    isLlmAvailable: () => true,
    chatCompletion: (...args: unknown[]) => chatCompletionMock(...args),
  };
});

/** Avoid writer fast path + low difficulty so parse-fallback clarification runs (planner → respond). */
vi.mock("../src/nodes/entry-classifier.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/nodes/entry-classifier.js")>();
  return {
    ...mod,
    classifyEntry: async (state: Parameters<typeof mod.classifyEntry>[0]) => {
      const res = await mod.classifyEntry(state);
      const prevControls = (res.taxonomy_metadata?.output_controls ?? {}) as Record<string, boolean>;
      return {
        ...res,
        task_is_trivial: false,
        plan_required: true,
        next_node: "planner",
        difficulty: Math.max(res.difficulty ?? 0, 0.75),
        rag_mode: "normal",
        taxonomy_metadata: {
          ...res.taxonomy_metadata,
          output_controls: { ...prevControls, clarify_first: true },
        },
      };
    },
  };
});

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function makeConfig() {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
  });
}

function parseSseContent(streamBody: string): string[] {
  const frames = streamBody.split("\n\n").map((f) => f.trim()).filter(Boolean);
  const contents: string[] = [];
  for (const frame of frames) {
    if (!frame.startsWith("data: ")) continue;
    const raw = frame.slice(6).trim();
    if (raw === "[DONE]") continue;
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string" && delta.content) contents.push(delta.content);
    } catch { /* skip */ }
  }
  return contents;
}

describe("SSE clarification streaming", () => {
  it("streams clarification question as content delta when writer is bypassed", async () => {
    // LLM returns invalid JSON → parse fallback → detectActionableAmbiguities triggers
    chatCompletionMock.mockResolvedValue({
      content: '{"title": "Not a valid plan schema"}',
      usage: {
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{
          role: "user",
          content: "Design a cloud architecture for an AI platform with model routing and workflow agents.",
        }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("[DONE]");

    const contentDeltas = parseSseContent(response.body);
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1);

    const fullContent = contentDeltas.join("");
    expect(fullContent).toContain("clarify");

    await app.close();
  });
});
