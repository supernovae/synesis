import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCompletionStreamMock = vi.fn();

vi.mock("../src/llm/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/client.js")>("../src/llm/client.js");
  return {
    ...actual,
    isLlmAvailable: () => true,
    chatCompletionStream: (...args: unknown[]) => chatCompletionStreamMock(...args),
  };
});

import { composeWriterDraftStream } from "../src/nodes/writer-compose.js";
import type { GraphState } from "../src/state/types.js";
import { ZERO_USAGE } from "../src/llm/client.js";

describe("composeWriterDraftStream mermaid guard", () => {
  const baseState: GraphState = {
    task_description: "Explain",
    messages: [{ role: "user", content: "Explain" }],
  };

  beforeEach(() => {
    chatCompletionStreamMock.mockReset();
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED;
    delete process.env.SYNESIS_PLANNER_TS_STREAM_MERMAID_GUARD_ENABLED;
  });

  it("streams raw deltas immediately by default even when the non-streaming mermaid guard is enabled", async () => {
    const raw = [
      "```mermaid",
      "graph TD",
      "B --> C[Model Server (vLLM, TGI)]",
      "```",
    ].join("\n");

    chatCompletionStreamMock.mockImplementation(
      async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
        onDelta({ content: raw });
        return {
          content: raw,
          usage: { ...ZERO_USAGE },
        };
      },
    );

    const deltas: string[] = [];
    const result = await composeWriterDraftStream(baseState, (d) => {
      if (d.content) deltas.push(d.content);
    });

    expect(result.content).toBe(raw);
    expect(deltas.join("")).toBe(raw);
  });

  it("buffers the LLM stream and emits guarded mermaid when streaming mermaid guard is explicitly enabled", async () => {
    process.env.SYNESIS_PLANNER_TS_STREAM_MERMAID_GUARD_ENABLED = "true";

    const raw = [
      "```mermaid",
      "graph TD",
      "B --> C[Model Server (vLLM, TGI)]",
      "```",
    ].join("\n");

    chatCompletionStreamMock.mockImplementation(
      async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
        onDelta({ content: raw });
        return {
          content: raw,
          usage: { ...ZERO_USAGE },
        };
      },
    );

    const deltas: string[] = [];
    const result = await composeWriterDraftStream(baseState, (d) => {
      if (d.content) deltas.push(d.content);
    });

    expect(result.content).toContain('C["Model Server (vLLM, TGI)"]');
    expect(result.content).not.toContain("C[Model Server (vLLM, TGI)]");
    expect(deltas.join("")).toBe(result.content);
  });
});
