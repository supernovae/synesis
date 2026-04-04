import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setFgaCheckOverride } from "../src/auth/openfga-client.js";

beforeAll(() => {
  setFgaCheckOverride(() => ({ allowed: true }));
});
afterAll(() => {
  setFgaCheckOverride(null);
});

const chatCompletionMock = vi.fn();

vi.mock("../src/llm/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/client.js")>("../src/llm/client.js");
  return {
    ...actual,
    isLlmAvailable: () => true,
    chatCompletion: (...args: unknown[]) => chatCompletionMock(...args),
  };
});

import { composeWriterDraft } from "../src/nodes/writer-compose.js";
import type { GraphState } from "../src/state/types.js";

describe("composeWriterDraft metadata JSON guard", () => {
  it("replaces tags-only JSON with deterministic fallback", async () => {
    chatCompletionMock.mockResolvedValue({
      content: '{"tags": ["Technology", "AI"]}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const state: GraphState = {
      task_description: "Explain the system",
      messages: [{ role: "user", content: "Explain the system" }],
    };

    const result = await composeWriterDraft(state);
    expect(result.content).not.toMatch(/^\s*\{\s*"tags"/);
    expect(result.content.length).toBeGreaterThan(40);
  });
});
